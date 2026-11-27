//! A fixed data slot populated on an owned executable copy before signing.
//! Changing release metadata never changes Cargo inputs or machine code.

pub const SLOT_BYTES: usize = 4096;
const MARKER: &[u8; 64] = include_bytes!("../release-metadata-marker.txt");

const fn empty_slot() -> [u8; SLOT_BYTES] {
    let mut bytes = [0; SLOT_BYTES];
    let mut index = 0;
    while index < MARKER.len() {
        bytes[index] = MARKER[index];
        index += 1;
    }
    bytes
}

#[used]
static RELEASE_METADATA: [u8; SLOT_BYTES] = empty_slot();

pub fn payload() -> Result<Option<Vec<u8>>, &'static str> {
    // SAFETY: the immutable static is aligned and valid for the entire array.
    // Volatile reads prevent LTO from replacing packaged bytes with the empty
    // compile-time initializer. The packager writes only before process start.
    let bytes = unsafe { std::ptr::read_volatile(&raw const RELEASE_METADATA) };
    let offset = MARKER.len();
    let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    if length == 0 {
        return Ok(None);
    }
    if length > SLOT_BYTES - offset - 4 {
        return Err("invalid executable release metadata length");
    }
    Ok(Some(bytes[offset + 4..offset + 4 + length].to_vec()))
}
