export type TextSink = (text: string) => void;

export function decodeChunks(sink: TextSink): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  return (chunk: Uint8Array) => {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) {
      sink(text);
    }
  };
}

export function collectText(): { sink: (chunk: Uint8Array) => void; text: () => string } {
  const parts: string[] = [];
  const push = decodeChunks((text) => parts.push(text));
  return { sink: push, text: () => parts.join("") };
}
