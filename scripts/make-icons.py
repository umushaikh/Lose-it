"""Generates the two PWA icons (192px, 512px) as plain PNGs, no external
image libraries required (this container has neither Pillow nor ImageMagick).
Draws a rounded-square background with a calorie "budget ring" motif so the
home-screen icon echoes the in-app ring.
"""
import math
import struct
import zlib

BG = (21, 128, 61)       # green-700
RING = (255, 255, 255)   # white
DOT = (251, 191, 36)     # amber-400


def rounded_square_mask(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius or (radius <= x <= size - radius) or (radius <= y <= size - radius)


def make_icon(size):
    radius = size * 0.22
    center = size / 2
    ring_outer = size * 0.36
    ring_inner = size * 0.27
    dot_radius = size * 0.09
    gap_start = -90  # degrees, ring gap sits at the top like a progress ring
    gap_end = -20

    pixels = bytearray(size * size * 4)

    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            if not rounded_square_mask(x + 0.5, y + 0.5, size, radius):
                pixels[idx:idx + 4] = (0, 0, 0, 0)
                continue

            dx = x + 0.5 - center
            dy = y + 0.5 - center
            dist = math.hypot(dx, dy)

            r, g, b, a = BG[0], BG[1], BG[2], 255

            if dist <= dot_radius:
                r, g, b = DOT
            elif ring_inner <= dist <= ring_outer:
                angle = math.degrees(math.atan2(dy, dx))
                if not (gap_start <= angle <= gap_end):
                    r, g, b = RING

            pixels[idx:idx + 4] = (r, g, b, a)

    return pixels


def write_png(path, size, pixels):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # no filter
        raw.extend(pixels[y * stride:(y + 1) * stride])

    compressed = zlib.compress(bytes(raw), 9)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', compressed))
        f.write(chunk(b'IEND', b''))


if __name__ == '__main__':
    for size, path in [(192, 'public/icons/icon-192.png'), (512, 'public/icons/icon-512.png')]:
        write_png(path, size, make_icon(size))
        print(f'wrote {path}')
