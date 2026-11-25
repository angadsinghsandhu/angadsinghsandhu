import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/stage-release-archive.py", import.meta.url),
);
const generated = fileURLToPath(new URL("../../.generated/", import.meta.url));
const fixture = String.raw`
import json, struct, sys, warnings, zipfile
archive, damage = sys.argv[1:]
warnings.filterwarnings("ignore", message="Duplicate name:")
with zipfile.ZipFile(archive, "w") as output:
    for name, mode in json.load(sys.stdin):
        member = zipfile.ZipInfo(name)
        member.external_attr = mode << 16
        data = b"" if name.endswith("/") else bytes([0, 10, 255])
        output.writestr(member, data, zipfile.ZIP_DEFLATED if name == "_redirects" else zipfile.ZIP_STORED)
if damage:
    with open(archive, "r+b") as output:
        data = bytearray(output.read())
        if damage == "late-crc":
            local = data.index(b"PK\x03\x04", 4)
            name_length = struct.unpack_from("<H", data, local + 26)[0]
            data[local + 30 + name_length] ^= 1
        elif damage == "truncated":
            del data[-12:]
        elif damage == "short-member":
            central = data.index(b"PK\x01\x02")
            struct.pack_into("<I", data, central + 24, 4)
        elif damage == "nul":
            data = data.replace(b"nul_file", b"nul\x00file")
        else:
            offset = data.index(b"PK\x01\x02")
            while data[offset:offset + 4] == b"PK\x01\x02":
                size = 25 * 1024 * 1024 + (damage == "file-size")
                struct.pack_into("<I", data, offset + 24, size)
                offset += 46 + sum(struct.unpack_from("<HHH", data, offset + 28))
        output.seek(0)
        output.write(data)
        output.truncate()
`;

describe("checked release archive staging", () => {
  let directory: string;
  let archive: string;
  let output: string;

  beforeEach(() => {
    mkdirSync(generated, { recursive: true });
    directory = mkdtempSync(join(generated, "portfolio-stage-"));
    archive = join(directory, "artifact.zip");
    output = join(directory, "staged");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function zip(names: string[], damage = "", mode = 0o100644) {
    const result = spawnSync("python3", ["-c", fixture, archive, damage], {
      encoding: "utf8",
      input: JSON.stringify(
        names.map((name) => [name, name.endsWith("/") ? 0o40755 : mode]),
      ),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }

  function stage() {
    return spawnSync("python3", [script, archive, output], {
      encoding: "utf8",
    });
  }

  function rejectArchive(message: RegExp) {
    const result = stage();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(directory)).toEqual(["artifact.zip"]);
  }

  it("preserves public file names and bytes in a private directory", () => {
    const names = [
      ".well-known/example",
      "_redirects",
      ".hidden",
      "space café/x",
      "empty/",
    ];
    zip(names);
    const result = stage();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(statSync(output).mode & 0o777).toBe(0o700);
    for (const name of names.slice(0, -1)) {
      expect(readFileSync(join(output, name))).toEqual(
        Buffer.from([0, 10, 255]),
      );
    }
    expect(readdirSync(join(output, "empty"))).toEqual([]);
  });

  it("leaves a preexisting destination untouched", () => {
    zip(["ok"]);
    mkdirSync(output);
    writeFileSync(join(output, "existing"), "keep");
    const result = stage();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/destination already exists/);
    expect(readdirSync(output)).toEqual(["existing"]);
  });

  it.each([
    "/escape",
    "../escape",
    "a/../escape",
    "./relative",
    "a//file",
    "C:/drive",
    "a\\backslash",
  ])("rejects an unsafe member name %s", (name) => {
    zip(["ok", name]);
    rejectArchive(/unsafe ZIP path/);
  });

  it("rejects embedded NUL even though zipfile trims the member name", () => {
    zip(["nul_file"], "nul");
    rejectArchive(/unsafe ZIP path/);
  });

  it.each([
    ["same", "same"],
    ["Case/a", "case/b"],
    ["café/a", "cafe\u0301/b"],
    ["file", "file/nested"],
    ["file/nested", "file"],
    ["dir/", "dir/"],
  ])("rejects conflicting paths %s and %s", (first, second) => {
    zip([first, second]);
    rejectArchive(/conflicting ZIP path/);
  });

  it.each([0o120777, 0o010644, 0o020644])(
    "rejects special Unix mode %s",
    (mode) => {
      zip(["special"], "", mode);
      rejectArchive(/unsupported ZIP member/);
    },
  );

  it("rejects more than 20,000 files", () => {
    zip(Array.from({ length: 20_001 }, (_, n) => `entry-${n}`));
    rejectArchive(/file count limit/);
  });

  it("bounds implied directory nodes even with few files", () => {
    const nested = "d/".repeat(62) + "file";
    zip(Array.from({ length: 626 }, (_, n) => `dir-${n}/${nested}`));
    rejectArchive(/path count limit/);
  });

  it("rejects paths nested beyond the staging depth limit", () => {
    zip(["d/".repeat(64) + "file"]);
    rejectArchive(/path depth limit/);
  });

  it("rejects a member above 25 MiB before opening its data", () => {
    zip(["large"], "file-size");
    rejectArchive(/per-file size limit/);
  });

  it("rejects an expanded total above 1.25 GiB before opening any data", () => {
    zip(
      Array.from({ length: 52 }, (_, n) => `entry-${n}`),
      "total-size",
    );
    rejectArchive(/expanded size limit/);
  });

  it("cleans staging after a late CRC failure", () => {
    zip(["ok", "bad"], "late-crc");
    rejectArchive(/Bad CRC/);
  });

  it("rejects fewer extracted bytes than the central directory declares", () => {
    zip(["ok"], "short-member");
    rejectArchive(/incomplete ZIP member/);
  });

  it("rejects a truncated ZIP without publishing output", () => {
    zip(["ok"], "truncated");
    rejectArchive(/File is not a zip file/);
  });
});
