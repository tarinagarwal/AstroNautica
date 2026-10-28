#!/bin/sh
# Regenerates the committed sample files in test/fixtures. Needs ffmpeg and exiftool
# (Debian/Ubuntu: apt-get install -y ffmpeg libimage-exiftool-perl). The fixtures are
# committed so the tests run without either tool; tests that decode with ffmpeg or read
# with exiftool are skipped when those tools are missing.
#
# Every fixture carries the kind of metadata a phone writes: GPS position, device make and
# model, serial number, capture timestamps, and XMP/IPTC duplicates of the same.
set -eu
cd "$(dirname "$0")/fixtures"
find . -type f ! -name p3.icc -delete

ff() { ffmpeg -v error -y "$@"; }
ex() { exiftool -q -q -overwrite_original "$@"; }
gps_tags() {
  ex -GPSLatitude=28.6139 -GPSLatitudeRef=N -GPSLongitude=77.2090 -GPSLongitudeRef=E -GPSAltitude=216 \
    -Make=Samsung -Model=SM-G991B -SerialNumber=R5CR10ABCDE -Software=G991BXXU5CVF1 \
    "-DateTimeOriginal=2024:05:01 10:20:30" "-CreateDate=2024:05:01 10:20:30" "-ModifyDate=2024:05:01 10:20:30" \
    "-XMP-dc:Creator=Jane Witness" -XMP-exif:GPSLatitude=28.6139 -XMP-exif:GPSLongitude=77.2090 \
    -XMP-tiff:Make=Samsung "$@"
}

# JPEG: Exif (GPS, device, times, orientation 6 = rotate 90 CW, embedded thumbnail), XMP,
# IPTC/Photoshop, ICC profile (Display P3, kept by default), comment, and a trailer after EOI.
ff -f lavfi -i testsrc2=size=64x48 -frames:v 1 -q:v 4 thumb.tmp.jpg
ff -f lavfi -i testsrc2=size=96x64 -frames:v 1 -q:v 3 gps.jpg
gps_tags "-IPTC:By-line=Jane Witness" "-IPTC:City=New Delhi" "-IPTC:Country-PrimaryLocationName=India" -Orientation#=6 -Comment="shot by Jane" "-ThumbnailImage<=thumb.tmp.jpg" \
  "-ICC_Profile<=p3.icc" gps.jpg
printf 'SEFHtrailer-with-device-data' >> gps.jpg
rm -f thumb.tmp.jpg

# Progressive JPEG with restart markers and Exif: exercises multi-scan entropy data.
ff -f lavfi -i testsrc2=size=80x60 -frames:v 1 -q:v 5 -huffman optimal progressive.tmp.jpg
exiftool -q -q -o progressive.jpg -Make=Apple "-Model=iPhone 15" -GPSLatitude=19.0760 -GPSLatitudeRef=N \
  -GPSLongitude=72.8777 -GPSLongitudeRef=E progressive.tmp.jpg
rm -f progressive.tmp.jpg

# PNG: eXIf (GPS), tEXt, zTXt, iTXt (XMP), tIME, iCCP.
ff -f lavfi -i testsrc2=size=48x32 -frames:v 1 gps.png
gps_tags "-PNG:Comment=shot by Jane" "-PNG:Author=Jane Witness" -PNG:Description=protest \
  "-PNG:ModifyDate=2024:05:01 10:20:30" "-ICC_Profile<=p3.icc" gps.png

# WebP (lossy, so exiftool upgrades it to the extended VP8X layout): EXIF, XMP, ICCP.
ff -f lavfi -i testsrc2=size=48x32 -frames:v 1 -c:v libwebp gps.webp
gps_tags "-ICC_Profile<=p3.icc" gps.webp

# MP4 as an Android phone writes it: udta ©xyz location, mdta make/model keys, creation times.
ff -f lavfi -i testsrc2=size=160x120:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 1 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 32k \
  -metadata location=+28.6139+077.2090/ -metadata make=Samsung -metadata model=SM-G991B \
  -metadata creation_time=2024-05-01T10:20:30Z -movflags use_metadata_tags phone.mp4
# exiftool adds XMP to an MP4 as a top-level uuid box.
ex "-XMP-dc:Creator=Jane Witness" -XMP-exif:GPSLatitude=28.6139 -XMP-exif:GPSLongitude=77.2090 phone.mp4
# exiftool rewrote phone.mp4 with moov before mdat (so shrinking moov would move mdat). Also keep a copy
# with ffmpeg's default layout (ftyp, free, mdat, moov at the end).
ff -i phone.mp4 -c copy -map_metadata 0 -movflags use_metadata_tags phone-moovlast.mp4

# MOV as an iPhone writes it: moov/meta keys (ISO6709 location, make, model, software,
# creation date), udta ©xyz, an XMP uuid box, and a timecode (tmcd) track.
ff -f lavfi -i testsrc2=size=160x120:rate=30 -t 1 -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -timecode 10:20:30:00 -metadata creation_time=2024-05-01T10:20:30Z -metadata location=+28.6139+077.2090/ \
  phone.mov
ex "-Keys:GPSCoordinates=28.6139, 77.2090, 216" -Keys:Make=Apple "-Keys:Model=iPhone 15 Pro" \
  -Keys:Software=17.4.1 "-Keys:CreationDate=2024:05:01 10:20:30+05:30" "-XMP-dc:Creator=Jane Witness" \
  "-XMP-exif:GPSLatitude=28.6139" phone.mov

# MP4 with a subtitle (data) track: the track and its samples must go.
printf '1\n00:00:00,000 --> 00:00:00,900\nLocation: Connaught Place, recorded by Jane\n' > subs.tmp.srt
ff -f lavfi -i testsrc2=size=160x120:rate=25 -i subs.tmp.srt -t 1 -c:v libx264 -preset veryfast \
  -pix_fmt yuv420p -c:s mov_text -metadata location=+28.6139+077.2090/ subtitled.mp4

# Fragmented MP4 (moof/traf/trun) with the same subtitle track and location metadata.
ff -f lavfi -i testsrc2=size=160x120:rate=25 -i subs.tmp.srt -t 1 -c:v libx264 -preset veryfast \
  -pix_fmt yuv420p -g 10 -c:s mov_text -metadata location=+28.6139+077.2090/ \
  -metadata creation_time=2024-05-01T10:20:30Z -movflags frag_keyframe+empty_moov fragmented.mp4
rm -f subs.tmp.srt

# HEIF-family file (AVIF here; HEIC needs a patent-encumbered encoder) to check rejection.
ff -f lavfi -i testsrc2=size=32x32 -frames:v 1 -c:v libaom-av1 -still-picture 1 sample.avif 2>/dev/null ||
  ff -f lavfi -i testsrc2=size=32x32 -frames:v 1 -c:v libsvtav1 sample.avif 2>/dev/null || true

ls -l
