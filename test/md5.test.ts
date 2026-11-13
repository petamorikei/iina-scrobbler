import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { md5, utf8Bytes } from "../src/services/md5.ts";

const nodeMd5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

test("RFC 1321 test suite", () => {
  const vectors: [string, string][] = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ];
  for (const [input, want] of vectors) assert.equal(md5(input), want, JSON.stringify(input));
});

test("UTF-8 input (value also verified inside IINA by the probe)", () => {
  assert.equal(md5("日本語のアーティスト"), "29772ebcad669e0075d1f52df091889b");
});

test("block-boundary lengths match node:crypto", () => {
  for (let n = 0; n <= 200; n++) {
    const s = "x".repeat(n);
    assert.equal(md5(s), nodeMd5(s), `length ${n}`);
  }
});

test("random mixed strings match node:crypto", () => {
  const pool = ["a", "Z", "0", " ", "&", "=", "?", "/", "é", "ß", "日", "本", "ー", "♪", "😀", "𝄞", "\u00a0", "\n"];
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  for (let i = 0; i < 2000; i++) {
    let s = "";
    const len = Math.floor(rand() * 80);
    for (let j = 0; j < len; j++) s += pool[Math.floor(rand() * pool.length)];
    assert.equal(md5(s), nodeMd5(s), JSON.stringify(s));
  }
});

test("lone surrogates are encoded as U+FFFD like Node", () => {
  for (const s of ["\ud800", "a\udc00b", "\ud83d", "x\ud83d😀"]) {
    assert.deepEqual(utf8Bytes(s), [...Buffer.from(s, "utf8")], JSON.stringify(s));
    assert.equal(md5(s), nodeMd5(s));
  }
});
