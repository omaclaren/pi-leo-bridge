function firstStopIndex(text: string, stopSequences: string[]): number {
  let first = -1;
  for (const stop of stopSequences) {
    const index = text.indexOf(stop);
    if (index >= 0 && (first < 0 || index < first)) {
      first = index;
    }
  }
  return first;
}

function partialStopSuffixLength(text: string, stopSequences: string[]): number {
  let longest = 0;
  for (const stop of stopSequences) {
    const maximum = Math.min(text.length, stop.length - 1);
    for (let length = maximum; length > longest; length -= 1) {
      if (stop.startsWith(text.slice(-length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export function filterCompleteOutput(
  text: string,
  assistantPrefix: string | null,
  stopSequences: string[],
): { text: string; stopped: boolean } {
  let output = text;
  if (assistantPrefix && output.startsWith(assistantPrefix)) {
    output = output.slice(assistantPrefix.length);
  }
  const stopIndex = firstStopIndex(output, stopSequences);
  if (stopIndex >= 0) {
    return { text: output.slice(0, stopIndex), stopped: true };
  }
  return { text: output, stopped: false };
}

export class StreamingOutputFilter {
  private undecidedPrefix = "";
  private prefixDecided: boolean;
  private pendingStop = "";
  private stopped_ = false;
  private output_ = "";

  constructor(
    private readonly assistantPrefix: string | null,
    private readonly stopSequences: string[],
    private readonly emit: (text: string) => void,
  ) {
    this.prefixDecided = !assistantPrefix;
  }

  get output(): string {
    return this.output_;
  }

  get stopped(): boolean {
    return this.stopped_;
  }

  push(delta: string): void {
    if (delta === "" || this.stopped_) {
      return;
    }
    if (!this.prefixDecided && this.assistantPrefix) {
      this.undecidedPrefix += delta;
      if (this.assistantPrefix.startsWith(this.undecidedPrefix)) {
        if (this.undecidedPrefix.length < this.assistantPrefix.length) {
          return;
        }
        this.undecidedPrefix = "";
        this.prefixDecided = true;
        return;
      }
      if (this.undecidedPrefix.startsWith(this.assistantPrefix)) {
        const remainder = this.undecidedPrefix.slice(this.assistantPrefix.length);
        this.undecidedPrefix = "";
        this.prefixDecided = true;
        this.pushAfterPrefix(remainder);
        return;
      }
      const buffered = this.undecidedPrefix;
      this.undecidedPrefix = "";
      this.prefixDecided = true;
      this.pushAfterPrefix(buffered);
      return;
    }
    this.pushAfterPrefix(delta);
  }

  finish(): void {
    if (this.stopped_) {
      this.undecidedPrefix = "";
      this.pendingStop = "";
      return;
    }
    if (!this.prefixDecided && this.undecidedPrefix !== "") {
      // Do not discard an incomplete partial match.
      this.pushAfterPrefix(this.undecidedPrefix);
      this.undecidedPrefix = "";
      this.prefixDecided = true;
    }
    if (this.pendingStop !== "") {
      this.emitText(this.pendingStop);
      this.pendingStop = "";
    }
  }

  private pushAfterPrefix(delta: string): void {
    if (delta === "" || this.stopped_) {
      return;
    }
    this.pendingStop += delta;
    const stopIndex = firstStopIndex(this.pendingStop, this.stopSequences);
    if (stopIndex >= 0) {
      this.emitText(this.pendingStop.slice(0, stopIndex));
      this.pendingStop = "";
      this.stopped_ = true;
      return;
    }

    const heldCharacters = partialStopSuffixLength(this.pendingStop, this.stopSequences);
    const emitLength = this.pendingStop.length - heldCharacters;
    if (emitLength > 0) {
      this.emitText(this.pendingStop.slice(0, emitLength));
      this.pendingStop = this.pendingStop.slice(emitLength);
    }
  }

  private emitText(text: string): void {
    if (text === "") {
      return;
    }
    this.output_ += text;
    this.emit(text);
  }
}
