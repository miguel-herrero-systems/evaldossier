import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonStrict, StrictJsonError } from "../src/json.js";

function hasStrictJsonCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof StrictJsonError && error.code === code;
}

test("malformed JSON is rejected with a fixed, bounded diagnostic", () => {
  const sourceLabel = "dense malformed fixture";
  const denseCommas = `[${",".repeat(512 * 1024 - 2)}]`;

  assert.throws(
    () => parseJsonStrict(denseCommas, sourceLabel),
    (error: unknown) => {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.code, "INVALID_JSON");
      assert.equal(error.message, `${sourceLabel}: invalid JSON document`);
      assert.equal(error.offset, undefined);
      assert.ok(error.message.length < 128);
      return true;
    },
  );
});

test("syntax admission does not reflect native parser diagnostics", () => {
  for (const malformed of ["", "{", "[1,]", '{"value":/* comment */1}']) {
    assert.throws(
      () => parseJsonStrict(malformed, "syntax fixture"),
      (error: unknown) => {
        assert.ok(error instanceof StrictJsonError);
        assert.equal(error.code, "INVALID_JSON");
        assert.equal(error.message, "syntax fixture: invalid JSON document");
        return true;
      },
    );
  }
});

test("post-parse diagnostics remain bounded for attacker-sized keys and paths", () => {
  const duplicateKey = "duplicate".repeat(32 * 1024);
  const duplicateDocument = `{${JSON.stringify(duplicateKey)}:1,${JSON.stringify(
    duplicateKey,
  )}:2}`;
  assert.throws(
    () => parseJsonStrict(duplicateDocument, "large duplicate fixture"),
    (error: unknown) => {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.code, "DUPLICATE_KEY");
      assert.ok(error.message.length < 1024);
      assert.doesNotMatch(error.message, /duplicateduplicate/u);
      return true;
    },
  );

  const depth = 64;
  const key = "path-segment".repeat(1024);
  let semanticDocument = "-0";
  for (let index = 0; index < depth; index += 1) {
    semanticDocument = `{${JSON.stringify(`${key}-${index}`)}:${semanticDocument}}`;
  }
  assert.throws(
    () => parseJsonStrict(semanticDocument, "large semantic fixture"),
    (error: unknown) => {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.code, "NEGATIVE_ZERO");
      assert.ok(error.message.length < 1024);
      assert.match(error.message, /sha256:/u);
      return true;
    },
  );
});

test("strict post-parse invariants remain enforced", async (t) => {
  await t.test("duplicate object members", () => {
    assert.throws(
      () => parseJsonStrict('{"decision":"first","decision":"second"}'),
      hasStrictJsonCode("DUPLICATE_KEY"),
    );
  });

  await t.test("UTF-8 BOM in bytes and strings", () => {
    assert.throws(
      () => parseJsonStrict(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
      hasStrictJsonCode("UNEXPECTED_BOM"),
    );
    assert.throws(() => parseJsonStrict("\ufeff{}"), hasStrictJsonCode("UNEXPECTED_BOM"));
  });

  await t.test("malformed UTF-8", () => {
    assert.throws(
      () => parseJsonStrict(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])),
      hasStrictJsonCode("INVALID_UTF8"),
    );
  });

  await t.test("maximum nesting depth", () => {
    const atLimit = `${"[".repeat(128)}0${"]".repeat(128)}`;
    const overLimit = `${"[".repeat(129)}0${"]".repeat(129)}`;
    assert.doesNotThrow(() => parseJsonStrict(atLimit));
    assert.throws(() => parseJsonStrict(overLimit), hasStrictJsonCode("MAX_DEPTH_EXCEEDED"));
  });

  await t.test("Unicode scalar strings", () => {
    assert.throws(
      () => parseJsonStrict('{"value":"\\ud800"}'),
      hasStrictJsonCode("INVALID_UNICODE_SCALAR"),
    );
    assert.throws(
      () => parseJsonStrict('{"value":"\\udc00"}'),
      hasStrictJsonCode("INVALID_UNICODE_SCALAR"),
    );
    assert.deepEqual(parseJsonStrict('{"value":"\\ud83d\\ude80"}'), { value: "🚀" });
  });

  await t.test("negative zero and unsafe integers", () => {
    assert.throws(() => parseJsonStrict('{"value":-0}'), hasStrictJsonCode("NEGATIVE_ZERO"));
    assert.throws(
      () => parseJsonStrict('{"value":9007199254740992}'),
      hasStrictJsonCode("UNSAFE_INTEGER"),
    );
  });

  await t.test("numeric overflow", () => {
    assert.throws(() => parseJsonStrict("1e400"), hasStrictJsonCode("NON_FINITE_NUMBER"));
    assert.throws(() => parseJsonStrict("-1e400"), hasStrictJsonCode("NON_FINITE_NUMBER"));
  });
});
