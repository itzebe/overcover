// esbuild `inject` entry. Some dependencies reference a bare `Buffer` and
// `process` global. Providing them here keeps the wallet bundle self-contained
// without changing any wallet code.
import { Buffer } from "buffer";
import process from "process";

export { Buffer, process };
