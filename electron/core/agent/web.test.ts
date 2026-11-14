import { describe, expect, it } from "vite-plus/test";
import { assertPublicUrl, htmlToText } from "./web";

describe("htmlToText", () => {
  it("strips scripts, styles and tags to readable lines", () => {
    const text = htmlToText(
      "<html><head><title>  Hi  </title><style>a{}</style></head><body><p>hello</p><script>x</script><div>world</div></body></html>",
    );
    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text).not.toContain("x");
    expect(text).not.toContain("a{}");
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http protocols", async () => {
    await expect(assertPublicUrl("file:///tmp/x")).rejects.toThrow(/http/i);
  });

  it("rejects localhost and private ranges", async () => {
    await expect(assertPublicUrl("http://localhost:8080")).rejects.toThrow(/not allowed/i);
    await expect(assertPublicUrl("http://10.0.0.5")).rejects.toThrow(/not allowed/i);
    await expect(assertPublicUrl("http://169.254.1.1")).rejects.toThrow(/not allowed/i);
  });

  it("allows public URLs", async () => {
    const url = await assertPublicUrl("https://docs.example.com/api");
    expect(url.hostname).toBe("docs.example.com");
  });
});
