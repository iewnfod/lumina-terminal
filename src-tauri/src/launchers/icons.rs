//! Icon-format byte wrapping shared by the launcher generators: PNG width
//! probing plus minimal Apple ICNS / Windows ICO containers around PNG
//! bytes. Pure — byte-exact tests drive these on every platform.

/// Big-endian width from a PNG's IHDR chunk, or None when the bytes are not
/// a PNG (or too short to carry an IHDR).
pub fn png_width(png: &[u8]) -> Option<u32> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    if png.len() < 24 || png[..8] != SIGNATURE || &png[12..16] != b"IHDR" {
        return None;
    }
    Some(u32::from_be_bytes([png[16], png[17], png[18], png[19]]))
}

/// The icns chunk type for a given pixel width (ic07=128, ic08=256,
/// ic09=512, ic10=1024/retina-512).
fn icns_chunk_type(width: u32) -> &'static [u8; 4] {
    match width {
        ..=128 => b"ic07",
        ..=256 => b"ic08",
        ..=512 => b"ic09",
        _ => b"ic10",
    }
}

/// Wrap PNG bytes in a minimal Apple ICNS container (one PNG-compressed
/// entry). Modern macOS reads PNG-in-ICNS directly, so no real encoder is
/// needed. Pure — tests byte-compare against the source PNG.
pub fn icns_from_png(png: &[u8]) -> Vec<u8> {
    let chunk_type = icns_chunk_type(png_width(png).unwrap_or(256));
    let chunk_len = (8 + png.len()) as u32;
    let total = (8 + chunk_len) as u32;

    let mut out = Vec::with_capacity(png.len() + 16);
    out.extend_from_slice(b"icns");
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(&chunk_len.to_be_bytes());
    out.extend_from_slice(png);
    out
}

/// Wrap PNG bytes in a minimal ICO container (one PNG-compressed entry;
/// supported since Vista). Pure — tests byte-compare against the source PNG.
pub fn ico_from_png(png: &[u8]) -> Vec<u8> {
    let width = png_width(png).unwrap_or(256);
    let mut out = Vec::with_capacity(png.len() + 22);
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type: icon
    out.extend_from_slice(&1u16.to_le_bytes()); // entry count
    out.push(if width >= 256 { 0 } else { width as u8 }); // width; 0 encodes 256
    out.push(if width >= 256 { 0 } else { width as u8 }); // height (square source)
    out.push(0); // palette size
    out.push(0); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // color planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    out.extend_from_slice(&(png.len() as u32).to_le_bytes()); // data size
    out.extend_from_slice(&22u32.to_le_bytes()); // data offset (after header)
    out.extend_from_slice(png);
    out
}
