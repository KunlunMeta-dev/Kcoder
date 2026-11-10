use super::super::manifest::{SOURCE_UPLOAD_MAX_BYTES, validate_manifest};
use super::*;
use kcoder_types::{migration::MigrationSourceKind, migration_source_upload::SourceUploadManifest};
use std::{
    cell::{Cell, RefCell},
    io::{self, Cursor},
    rc::Rc,
};

fn fixture(files: &[(&str, &[u8])]) -> ValidatedManifest {
    validate_manifest(SourceUploadManifest {
        version: 1,
        source: MigrationSourceKind::ClaudeCode,
        files: files
            .iter()
            .map(|(path, bytes)| SourceUploadFile {
                relative_path: (*path).into(),
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            })
            .collect(),
    })
    .unwrap()
}
fn encode(manifest: &ValidatedManifest, files: &[&[u8]]) -> Vec<u8> {
    let mut output = Vec::new();
    write_package(
        manifest,
        &mut output,
        |index, _| Ok(Cursor::new(files[index])),
        &mut || Ok(()),
    )
    .unwrap();
    output
}
fn raw_package(json: &[u8], body: &[u8]) -> Vec<u8> {
    [
        SOURCE_PACKAGE_MAGIC.as_slice(),
        &(json.len() as u64).to_le_bytes(),
        json,
        body,
    ]
    .concat()
}

#[test]
fn streaming_roundtrip_preserves_offsets_order_empty_files_and_bounded_io() {
    let large = vec![b'x'; SOURCE_PACKAGE_CHUNK_BYTES * 3 + 7];
    let files: [&[u8]; 3] = [b"{\"model\":\"synthetic\"}", &[], &large];
    let manifest = fixture(&[
        ("settings.json", files[0]),
        ("empty.md", files[1]),
        ("skills/example/SKILL.md", files[2]),
    ]);
    let max_read = Rc::new(Cell::new(0));
    let mut bytes = Vec::new();
    let written = write_package(
        &manifest,
        &mut bytes,
        |index, _| {
            Ok(CountingReader {
                cursor: Cursor::new(files[index]),
                max: max_read.clone(),
            })
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(written, bytes.len() as u64);
    assert!(max_read.get() <= SOURCE_PACKAGE_CHUNK_BYTES);
    let mut reader = PackageReader::new(Cursor::new(bytes), &mut || Ok(())).unwrap();
    assert_eq!(reader.manifest().sha256(), manifest.sha256());
    assert_eq!(
        reader.entries()[1].offset,
        reader.entries()[0].offset + files[0].len() as u64
    );
    assert_eq!(reader.entries()[2].offset, reader.entries()[1].offset);
    for (index, expected) in files.iter().enumerate().rev() {
        let mut output = ShortWriter(Vec::new());
        assert_eq!(
            reader
                .copy_file(index, &mut output, &mut || Ok(()))
                .unwrap(),
            expected.len() as u64
        );
        assert_eq!(&output.0, expected);
    }
    reader.verify_all(&mut || Ok(())).unwrap();
    assert!(
        reader
            .copy_file(3, &mut io::sink(), &mut || Ok(()))
            .is_err()
    );
}

#[test]
fn forged_header_overflow_noncanonical_manifest_truncation_and_trailing_bytes_fail() {
    let manifest = fixture(&[("settings.json", b"abc")]);
    let valid = encode(&manifest, &[b"abc"]);
    let mut wrong_magic = valid.clone();
    wrong_magic[0] = b'X';
    let mut overflow = valid.clone();
    overflow[8..16].copy_from_slice(&u64::MAX.to_le_bytes());
    let mut zero = valid.clone();
    zero[8..16].fill(0);
    let pretty = serde_json::to_vec_pretty(manifest.manifest()).unwrap();
    let spaced = raw_package(&pretty, b"abc");
    let mut extra = valid.clone();
    extra.push(0);
    for bytes in [
        wrong_magic,
        overflow,
        zero,
        spaced,
        extra,
        valid[..8].to_vec(),
        valid[..15].to_vec(),
        valid[..valid.len() - 1].to_vec(),
    ] {
        assert!(PackageReader::new(Cursor::new(bytes), &mut || Ok(())).is_err());
    }
    let mut linked = serde_json::to_value(manifest.manifest()).unwrap();
    linked["files"][0]["symlink"] = serde_json::json!("elsewhere");
    assert!(
        PackageReader::new(
            Cursor::new(raw_package(&serde_json::to_vec(&linked).unwrap(), b"abc")),
            &mut || Ok(())
        )
        .is_err()
    );
}

#[test]
fn construction_never_claims_payload_verification_and_copy_checks_actual_returned_bytes() {
    let manifest = fixture(&[("settings.json", b"abc")]);
    let mut altered = encode(&manifest, &[b"abc"]);
    *altered.last_mut().unwrap() = b'!';
    let mut reader = PackageReader::new(Cursor::new(altered), &mut || Ok(())).unwrap();
    assert!(reader.verify_all(&mut || Ok(())).is_err());
    let contents = vec![b'a'; SOURCE_PACKAGE_CHUNK_BYTES * 3];
    let manifest = fixture(&[("history.jsonl", &contents)]);
    let original = encode(&manifest, &[&contents]);
    let data_start = original.len() - contents.len();
    let shared = Rc::new(RefCell::new(original));
    let mut reader = PackageReader::new(
        MutatingReader {
            bytes: shared.clone(),
            position: 0,
            data_start,
            change_offset: data_start + SOURCE_PACKAGE_CHUNK_BYTES,
            mutated: false,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut partial = Vec::new();
    assert!(reader.copy_file(0, &mut partial, &mut || Ok(())).is_err());
    assert_eq!(partial.len(), contents.len());
    assert_ne!(partial, contents);
}

#[test]
fn stale_index_rejects_changed_manifest_before_returning_any_payload() {
    let manifest = fixture(&[("settings.json", b"abc")]);
    let bytes = encode(&manifest, &[b"abc"]);
    let shared = Rc::new(RefCell::new(bytes));
    let mut reader = PackageReader::new(
        SharedReader {
            bytes: shared.clone(),
            position: 0,
        },
        &mut || Ok(()),
    )
    .unwrap();
    shared.borrow_mut()[16] ^= 1;
    let mut output = Vec::new();
    assert!(reader.copy_file(0, &mut output, &mut || Ok(())).is_err());
    assert!(output.is_empty());
}

#[test]
fn a_manifest_changed_during_an_otherwise_valid_copy_is_not_reported_as_verified() {
    let manifest = fixture(&[("settings.json", b"abc")]);
    let encoded = encode(&manifest, &[b"abc"]);
    let data_start = encoded.len() - 3;
    let mut reader = PackageReader::new(
        MutatingReader {
            bytes: Rc::new(RefCell::new(encoded)),
            position: 0,
            data_start,
            change_offset: 16,
            mutated: false,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut partial = Vec::new();
    let error = reader
        .copy_file(0, &mut partial, &mut || Ok(()))
        .unwrap_err();
    assert_eq!(partial, b"abc");
    assert_eq!(error.to_string(), "source_upload_package_changed");
}

#[test]
fn streaming_cancellation_stops_before_next_chunk_without_success_or_implicit_replay() {
    let body = vec![b'x'; SOURCE_PACKAGE_CHUNK_BYTES * 4];
    let manifest = fixture(&[("history.jsonl", &body)]);
    let consumed = Rc::new(Cell::new(0));
    let mut partial = Vec::new();
    let mut opened = 0;
    let error = write_package(
        &manifest,
        &mut partial,
        |_, _| {
            opened += 1;
            Ok(ProgressReader {
                cursor: Cursor::new(&body),
                consumed: consumed.clone(),
            })
        },
        &mut || {
            ensure!(
                consumed.get() < SOURCE_PACKAGE_CHUNK_BYTES,
                "synthetic_cancelled"
            );
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "synthetic_cancelled");
    assert_eq!(opened, 1);
    assert_eq!(consumed.get(), SOURCE_PACKAGE_CHUNK_BYTES);
    assert_eq!(partial.len(), 16 + manifest.canonical_json().len());
    let encoded = encode(&manifest, &[&body]);
    let mut reader = PackageReader::new(Cursor::new(encoded), &mut || Ok(())).unwrap();
    let accepted = Rc::new(Cell::new(0));
    let mut output = ProgressWriter {
        accepted: accepted.clone(),
    };
    assert!(
        reader
            .copy_file(0, &mut output, &mut || {
                ensure!(
                    accepted.get() < SOURCE_PACKAGE_CHUNK_BYTES,
                    "synthetic_cancelled"
                );
                Ok(())
            })
            .is_err()
    );
    assert_eq!(accepted.get(), SOURCE_PACKAGE_CHUNK_BYTES);
}

#[test]
fn writer_refuses_truncated_extended_or_wrong_digest_files_and_failed_output() {
    let manifest = fixture(&[("config.toml", b"abc")]);
    for source in [b"ab".as_slice(), b"abcd".as_slice(), b"xyz".as_slice()] {
        assert!(
            write_package(
                &manifest,
                &mut Vec::new(),
                |_, _| Ok(Cursor::new(source)),
                &mut || Ok(())
            )
            .is_err()
        );
    }
    let error = write_package(
        &manifest,
        &mut FailingWriter,
        |_, _| Ok(Cursor::new(b"abc")),
        &mut || Ok(()),
    )
    .unwrap_err();
    assert!(!error.to_string().contains("UNTRUSTED_PRIVATE_ERROR"));
    let error = write_package(
        &manifest,
        &mut Vec::new(),
        |_, _| Err::<Cursor<&[u8]>, _>(anyhow::anyhow!("UNTRUSTED_PRIVATE_ERROR")),
        &mut || Ok(()),
    )
    .unwrap_err();
    assert_eq!(format!("{error:#}"), "source_upload_file_open_failed");
    let mut empty = fixture(&[("empty.md", b"")]).manifest().clone();
    empty.files[0].sha256 = "a".repeat(64);
    let wrong = validate_manifest(empty).unwrap();
    assert!(
        write_package(
            &wrong,
            &mut Vec::new(),
            |_, _| Ok(Cursor::new([])),
            &mut || Ok(())
        )
        .is_err()
    );
}

#[test]
fn full_two_gib_payload_fits_container_metadata_budget_without_allocating_the_payload() {
    let mut raw = fixture(&[("history.jsonl", b"")]).manifest().clone();
    raw.files[0].bytes = SOURCE_UPLOAD_MAX_BYTES;
    let manifest = validate_manifest(raw).unwrap();
    let header = raw_package(manifest.canonical_json(), &[]);
    let actual_length = header.len() as u64 + SOURCE_UPLOAD_MAX_BYTES;
    let mut reader = PackageReader::new(
        SparseReader {
            header: Cursor::new(header),
            length: actual_length,
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(reader.total_container_bytes(), actual_length);
    assert!(actual_length <= SOURCE_PACKAGE_MAX_BYTES);
    assert_eq!(reader.entries()[0].bytes, SOURCE_UPLOAD_MAX_BYTES);
    assert!(
        reader
            .copy_file(0, &mut io::sink(), &mut || Err(anyhow::anyhow!(
                "synthetic_cancelled"
            )))
            .is_err()
    );
}

struct CountingReader<'a> {
    cursor: Cursor<&'a [u8]>,
    max: Rc<Cell<usize>>,
}
impl Read for CountingReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.max.set(self.max.get().max(buf.len()));
        self.cursor.read(buf)
    }
}
struct ShortWriter(Vec<u8>);
impl Write for ShortWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = bytes.len().min(173);
        self.0.extend_from_slice(&bytes[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct ProgressReader<'a> {
    cursor: Cursor<&'a Vec<u8>>,
    consumed: Rc<Cell<usize>>,
}
impl Read for ProgressReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.cursor.read(buf)?;
        self.consumed.set(self.consumed.get() + n);
        Ok(n)
    }
}
struct ProgressWriter {
    accepted: Rc<Cell<usize>>,
}
impl Write for ProgressWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.accepted.set(self.accepted.get() + bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct FailingWriter;
impl Write for FailingWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("UNTRUSTED_PRIVATE_ERROR"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct SharedReader {
    bytes: Rc<RefCell<Vec<u8>>>,
    position: u64,
}
impl Read for SharedReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let bytes = self.bytes.borrow();
        let mut cursor = Cursor::new(bytes.as_slice());
        cursor.set_position(self.position);
        let count = cursor.read(out)?;
        self.position = cursor.position();
        Ok(count)
    }
}
impl Seek for SharedReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let bytes = self.bytes.borrow();
        let mut cursor = Cursor::new(bytes.as_slice());
        cursor.set_position(self.position);
        self.position = cursor.seek(from)?;
        Ok(self.position)
    }
}
struct MutatingReader {
    bytes: Rc<RefCell<Vec<u8>>>,
    position: u64,
    data_start: usize,
    change_offset: usize,
    mutated: bool,
}
impl Read for MutatingReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let mut inner = SharedReader {
            bytes: self.bytes.clone(),
            position: self.position,
        };
        let count = inner.read(out)?;
        self.position = inner.position;
        if !self.mutated && self.position as usize > self.data_start {
            self.mutated = true;
            self.bytes.borrow_mut()[self.change_offset] ^= 1;
        }
        Ok(count)
    }
}
impl Seek for MutatingReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let mut inner = SharedReader {
            bytes: self.bytes.clone(),
            position: self.position,
        };
        self.position = inner.seek(from)?;
        Ok(self.position)
    }
}
struct SparseReader {
    header: Cursor<Vec<u8>>,
    length: u64,
}
impl Read for SparseReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.header.read(bytes)
    }
}
impl Seek for SparseReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        match from {
            SeekFrom::End(delta) => {
                let offset = self
                    .length
                    .checked_add_signed(delta)
                    .ok_or_else(|| io::Error::other("invalid synthetic seek"))?;
                self.header.set_position(offset);
                Ok(offset)
            }
            other => self.header.seek(other),
        }
    }
}
