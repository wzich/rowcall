export const rowcallVersion = Deno.readTextFileSync(
  new URL("./VERSION", import.meta.url),
).trim();
