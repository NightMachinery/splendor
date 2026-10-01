/**
 * Dependency-free MD5 (RFC 1321) over the UTF-8 bytes of a string.
 *
 * Why MD5: both long-poll servers decide whether to hold a request by comparing
 * the client's `hash` query parameter with `DigestUtils.md5Hex(body)`, where
 * `body` is the exact JSON string they are about to send:
 * - the Game Service through simpoll `ResultGenerator.getHash`;
 * - the Lobby Service through asyncrestlib `BroadcastContentHasher.hash`.
 * `md5Hex(String)` hashes the string's UTF-8 bytes, and both endpoints send
 * `application/json; charset=utf-8`, so hashing the text returned by
 * `Response.text()` reproduces the server's hash exactly.
 *
 * MD5 is used only as a change detector here, never for security. It is
 * implemented in plain JS because `crypto.subtle` has no MD5 and is missing
 * altogether in insecure (plain http) contexts.
 */

// Per-round left-rotation amounts.
const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i + 1)) * 2^32), written out so that no engine's sin()
// rounding can change the result.
const K = Int32Array.from([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

/**
 * Encode a string as UTF-8. Uses TextEncoder when present (it is available in
 * insecure contexts too) and a manual encoder otherwise. Unpaired surrogates
 * become U+FFFD, as TextEncoder does; they cannot occur in text decoded from an
 * HTTP body anyway.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export const utf8Bytes = (text) => {
    if(typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(text);
    }
    const out = [];
    for(let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if(c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if(low >= 0xdc00 && low <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
                i++;
            } else {
                c = 0xfffd;
            }
        } else if(c >= 0xd800 && c <= 0xdfff) {
            c = 0xfffd;
        }
        if(c < 0x80) {
            out.push(c);
        } else if(c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if(c < 0x10000) {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return Uint8Array.from(out);
};

/**
 * MD5 of a byte array, as 32 lowercase hex digits.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const md5HexBytes = (bytes) => {
    const len = bytes.length;
    // message + 0x80 + zero padding + 8 length bytes, in whole 64-byte blocks
    const blockCount = ((len + 8) >>> 6) + 1;
    const words = new Int32Array(blockCount * 16);
    for(let i = 0; i < len; i++) {
        words[i >> 2] |= bytes[i] << ((i & 3) * 8);
    }
    words[len >> 2] |= 0x80 << ((len & 3) * 8);
    // bit length as a little-endian 64-bit integer
    words[blockCount * 16 - 2] = (len * 8) >>> 0;
    words[blockCount * 16 - 1] = Math.floor(len / 0x20000000);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476;

    for(let block = 0; block < words.length; block += 16) {
        let a = a0, b = b0, c = c0, d = d0;
        for(let i = 0; i < 64; i++) {
            let f, g;
            if(i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if(i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) & 15;
            } else if(i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) & 15;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) & 15;
            }
            const x = (a + f + K[i] + words[block + g]) | 0;
            a = d;
            d = c;
            c = b;
            b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
        }
        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
    }

    let hex = "";
    for(const v of [a0, b0, c0, d0]) {
        for(let j = 0; j < 4; j++) {
            hex += ((v >>> (j * 8)) & 0xff).toString(16).padStart(2, "0");
        }
    }
    return hex;
};

/**
 * MD5 of the UTF-8 encoding of a string, as 32 lowercase hex digits.
 * Matches Java's `DigestUtils.md5Hex(String)`.
 *
 * @param {string} text
 * @returns {string}
 */
export const md5Hex = (text) => md5HexBytes(utf8Bytes(text));

/**
 * Async wrapper kept for existing callers.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export const hashText = async (text) => md5Hex(text);
