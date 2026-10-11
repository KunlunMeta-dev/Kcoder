//! Shared native-vision image admission. Never invokes OCR or silently crops.
use std::io::Cursor;
pub const MAX_EDGE: u32 = 8192;
pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;
pub const SMALL_EDGE: u32 = 32;
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
#[derive(Debug, Clone, Copy)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
}
impl ImageInfo {
    pub fn small_warning(self) -> Option<String> {
        (self.width.min(self.height) < SMALL_EDGE).then(|| format!(
            "Image dimensions are small: {}x{} pixels (recommended shortest edge: at least {SMALL_EDGE}). Fine details may be unreadable; provide a clearer image if needed. The original image is still passed to the model's native vision, without OCR.", self.width, self.height))
    }
}
pub fn dimensions(width: u32, height: u32) -> Result<ImageInfo, String> {
    if width == 0 || height == 0 {
        return Err("Invalid image dimensions: width and height must be positive".into());
    }
    if width.max(height) > MAX_EDGE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(format!(
            "Image dimensions are too large: {width}x{height} pixels. Maximum edge: {MAX_EDGE}; maximum total: {MAX_PIXELS} pixels. Resize proportionally before sending; the image was not sent to the model and was not converted with OCR."
        ));
    }
    Ok(ImageInfo { width, height })
}
pub fn inspect(bytes: &[u8], mime: &str) -> Result<ImageInfo, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "Image file is too large: {} bytes; maximum {MAX_BYTES} bytes. Resize or compress it before sending.",
            bytes.len()
        ));
    }
    let format = image::guess_format(bytes).map_err(|_| "Invalid image data".to_owned())?;
    if format.to_mime_type() != mime {
        return Err("Image MIME type does not match its bytes".into());
    }
    let reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Cannot read image dimensions".to_owned())?;
    let info = dimensions(width, height)?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| {
        "Invalid image or image exceeds the 64 MiB decoding memory limit".to_owned()
    })?;
    Ok(info)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dimensions_report_actual_size_and_small_images_remain_usable() {
        assert!(dimensions(9000, 100).unwrap_err().contains("9000x100"));
        assert!(dimensions(8192, 8192).is_err());
        assert!(dimensions(0, 100).is_err());
        assert!(dimensions(3840, 2160).unwrap().small_warning().is_none());
        assert!(
            dimensions(16, 16)
                .unwrap()
                .small_warning()
                .unwrap()
                .contains("16x16")
        );
    }
    #[test]
    fn encoded_images_require_valid_bytes_and_matching_mime() {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(32, 32)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert_eq!(inspect(bytes.get_ref(), "image/png").unwrap().width, 32);
        assert!(inspect(bytes.get_ref(), "image/jpeg").is_err());
        assert!(inspect(b"broken", "image/png").is_err());
    }
}
