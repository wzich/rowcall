import { assertEquals } from "@std/assert";
import { pythonSyntaxLocationFromOffset } from "./pythonSyntaxError.ts";

Deno.test("pythonSyntaxLocationFromOffset maps a later line and column", () => {
  const code = "value = 1\nresult = )";
  assertEquals(pythonSyntaxLocationFromOffset(code, code.indexOf(")")), {
    line: 2,
    column: 10,
  });
});

Deno.test("pythonSyntaxLocationFromOffset maps the start of a line", () => {
  const code = "if ready:\nvalue = 1";
  assertEquals(
    pythonSyntaxLocationFromOffset(code, code.indexOf("value")),
    {
      line: 2,
      column: 1,
    },
  );
});
