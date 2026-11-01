"""Which certificate signed an APK — read from the APK Signing Block itself, never from apksigner's text output.

    python3 -I tools/apk_cert.py <apk>...

Prints one line per APK:

    APK <name> SCHEMES <v2,v3,v3.1> CERTS <n distinct> SHA256 <sha256 of the DER certificate> CN <subject CN>

(more than one distinct certificate: SHA256 lists each, comma-separated, and CN each, " | "-separated). An APK with no
APK Signing Block, or none with a v2/v3/v3.1 signer, prints `APK <name> NO-SIGNING-BLOCK …`; a damaged one
`APK <name> UNREADABLE …`. Exit: 0 = every APK has a signing block, 2 = at least one has none or could not be read.

Why: on 1 Nov 2026 `apksigner verify --print-certs` (build-tools 37.0.0) exited 0 but printed nothing the scripts'
patterns (`Signer #1 certificate DN: …`) recognised, so the signer was "?". The layout read here is the APK Signature
Scheme v2/v3 format itself: the ZIP end record names the central directory, the 16-byte magic `APK Sig Block 42` ends
the block just before it, and every v2 (0x7109871a), v3 (0xf05368c0) and v3.1 (0x1b93ad61) signer lists its X.509
certificates (DER) inside its signed data. minSdk is 26, so phones verify v2/v3 only; a v1 (JAR) signature is never
consulted. Nothing is verified here: `apksigner verify` (exit 0) stays the signature-validity check; this says WHICH
certificate signed. Prints public certificate data only. Standard library only, python 3.6+.
"""
import hashlib
import os
import struct
import sys

EOCD_SIG = b"PK\x05\x06"
BLOCK_MAGIC = b"APK Sig Block 42"
SCHEMES = ((0x7109871A, "v2"), (0xF05368C0, "v3"), (0x1B93AD61, "v3.1"))
CN_OID = b"\x55\x04\x03"   # 2.5.4.3 commonName


class Unreadable(Exception):
    pass


def _lp(buf, off):
    """The uint32-length-prefixed field at `off`: (its bytes, the offset after it)."""
    if off + 4 > len(buf):
        raise Unreadable("truncated length prefix")
    n = struct.unpack_from("<I", buf, off)[0]
    if off + 4 + n > len(buf):
        raise Unreadable("a length-prefixed field runs past its container")
    return buf[off + 4:off + 4 + n], off + 4 + n


def _seq(buf):
    """Every element of a sequence of uint32-length-prefixed elements that fills `buf`."""
    off, out = 0, []
    while off < len(buf):
        item, off = _lp(buf, off)
        out.append(item)
    return out


def signing_block(f):
    """{pair id: value} of the APK Signing Block of an open APK, or None if it has no block."""
    f.seek(0, os.SEEK_END)
    size = f.tell()
    if size < 22:
        raise Unreadable("too short for a ZIP file")
    tail_len = min(size, 22 + 0xFFFF)              # end record + the longest ZIP comment
    f.seek(size - tail_len)
    tail = f.read(tail_len)
    eocd = -1
    for i in range(len(tail) - 22, -1, -1):        # the last end record whose comment length reaches the file's end
        if tail[i:i + 4] == EOCD_SIG and struct.unpack_from("<H", tail, i + 20)[0] == len(tail) - i - 22:
            eocd = i
            break
    if eocd < 0:
        raise Unreadable("no ZIP end-of-central-directory record")
    cd_off = struct.unpack_from("<I", tail, eocd + 16)[0]
    if cd_off > size - tail_len + eocd:
        raise Unreadable("central directory offset past the end record (ZIP64 or damaged)")
    if cd_off < 32:
        return None
    f.seek(cd_off - 24)
    footer = f.read(24)                            # uint64 block size, then the magic, right before the directory
    if len(footer) != 24 or footer[8:] != BLOCK_MAGIC:
        return None
    bsize = struct.unpack_from("<Q", footer, 0)[0]
    start = cd_off - 8 - bsize
    if bsize < 24 or start < 0:
        raise Unreadable("APK Signing Block size out of range")
    f.seek(start)
    block = f.read(bsize + 8)
    if len(block) != bsize + 8 or struct.unpack_from("<Q", block, 0)[0] != bsize:
        raise Unreadable("the two size fields of the APK Signing Block disagree")
    pairs, off, end = {}, 8, len(block) - 24
    while off < end:                               # ID-value pairs: uint64 length (id + value), uint32 id, value
        if off + 12 > end:
            raise Unreadable("truncated ID-value pair")
        n, pid = struct.unpack_from("<QI", block, off)
        if n < 4 or off + 8 + n > end:
            raise Unreadable("ID-value pair length out of range")
        pairs.setdefault(pid, block[off + 12:off + 8 + n])
        off += 8 + n
    return pairs


def certificates(value):
    """The DER certificates of every signer of a v2/v3/v3.1 value: length-prefixed signers; each signer starts with
    its length-prefixed signed data = [digests][certificates (each length-prefixed DER)][…] — the same in all three."""
    out = []
    signers, _ = _lp(value, 0)
    for signer in _seq(signers):
        signed_data, _ = _lp(signer, 0)
        _digests, off = _lp(signed_data, 0)
        certs, _ = _lp(signed_data, off)
        out.extend(_seq(certs))
    return out


def _tlv(buf, off):
    """The DER element at `off`: (tag, contents, offset after it)."""
    if off + 2 > len(buf):
        raise Unreadable("truncated DER element")
    tag, n = buf[off], buf[off + 1]
    off += 2
    if tag & 0x1F == 0x1F:
        raise Unreadable("multi-byte DER tag")
    if n & 0x80:
        k = n & 0x7F
        if not 1 <= k <= 4 or off + k > len(buf):
            raise Unreadable("bad DER length")
        n = int.from_bytes(buf[off:off + k], "big")
        off += k
    if off + n > len(buf):
        raise Unreadable("DER element runs past its container")
    return tag, buf[off:off + n], off + n


def _text(tag, val):
    if tag == 0x1E:                                # BMPString
        s = val.decode("utf-16-be", "replace")
    elif tag == 0x1C:                              # UniversalString
        s = val.decode("utf-32-be", "replace")
    elif tag == 0x0C:                              # UTF8String
        s = val.decode("utf-8", "replace")
    else:                                          # PrintableString, IA5String, TeletexString …
        s = val.decode("latin-1")
    return "".join(c if c.isprintable() else "?" for c in s)


def subject_cn(der):
    """The commonName (2.5.4.3) of the certificate's SUBJECT — not its issuer; '?' if none or unreadable."""
    try:
        _, cert, _ = _tlv(der, 0)                  # Certificate ::= SEQUENCE { tbsCertificate, … }
        _, tbs, _ = _tlv(cert, 0)
        tag, _, off = _tlv(tbs, 0)                 # [0] version (optional), else serialNumber
        if tag == 0xA0:
            _, _, off = _tlv(tbs, off)             # serialNumber
        for _ in range(3):                         # signature, issuer, validity
            _, _, off = _tlv(tbs, off)
        tag, subject, _ = _tlv(tbs, off)           # subject Name ::= SEQUENCE OF SET OF SEQUENCE { OID, value }
        if tag != 0x30:
            return "?"
        cns, off = [], 0
        while off < len(subject):
            _, rdn, off = _tlv(subject, off)
            roff = 0
            while roff < len(rdn):
                _, atv, roff = _tlv(rdn, roff)
                otag, oid, aoff = _tlv(atv, 0)
                if otag == 0x06 and oid == CN_OID:
                    vtag, val, _ = _tlv(atv, aoff)
                    cns.append(_text(vtag, val))
        return "+".join(cns) if cns else "?"
    except Unreadable:
        return "?"


def describe(path):
    """(the line for one APK, whether it has a v2/v3 signing block)."""
    name = "".join(c if c.isprintable() and not c.isspace() else "_" for c in os.path.basename(path)) or "?"
    try:
        with open(path, "rb") as f:
            pairs = signing_block(f)
        found = [label for pid, label in SCHEMES if pairs and pid in pairs]
        if not found:
            return ("APK %s NO-SIGNING-BLOCK (no APK Signature Scheme v2/v3 signer: unsigned, or v1 (JAR) only)" % name,
                    False)
        certs = []                                 # distinct, in order of first appearance (v2, v3, v3.1)
        for pid, _label in SCHEMES:
            if pid in pairs:
                for der in certificates(pairs[pid]):
                    if der not in certs:
                        certs.append(der)
        return ("APK %s SCHEMES %s CERTS %d SHA256 %s CN %s" % (
            name, ",".join(found), len(certs), ",".join(hashlib.sha256(c).hexdigest() for c in certs) or "-",
            " | ".join(subject_cn(c) for c in certs) or "-"), True)
    except (OSError, Unreadable, struct.error) as e:
        return "APK %s UNREADABLE (%s)" % (name, e), False


def main(argv):
    if not argv:
        print("usage: python3 -I apk_cert.py <apk>...", file=sys.stderr)
        return 2
    rc = 0
    for path in argv:
        line, ok = describe(path)
        print(line)
        rc = rc if ok else 2
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
