import { pipeline, Transform, type Readable } from "node:stream";

/** Passes `body` through, failing if it carries more or fewer than `length` bytes. */
export function exactLength(body: Readable, length: number): Readable {
  let seen = 0;
  const checked = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > length) callback(new Error(`Body is longer than ${length} bytes`));
      else callback(null, chunk);
    },
    flush(callback) {
      if (seen < length) callback(new Error(`Body ended after ${seen} of ${length} bytes`));
      else callback();
    },
  });
  // The error surfaces on `checked`, which is what consumers listen to.
  return pipeline(body, checked, () => {});
}
