import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindTranscriptUserScrollTracker,
  renderTranscript,
} from "../src/transcript-render";
import type { Turn } from "../src/types";

const TEXT_NODE = 3;

class FakeText {
  readonly nodeType = TEXT_NODE;
  parentElement: FakeElement | null = null;

  constructor(public data: string) {}

  get textContent() {
    return this.data;
  }

  set textContent(value: string) {
    this.data = value;
  }
}

class FakeElement {
  children: FakeElement[] = [];
  childNodes: Array<FakeElement | FakeText> = [];
  dataset: Record<string, string> = {};
  className = "";
  parentElement: FakeElement | null = null;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  dateTime = "";
  private listeners = new Map<string, Array<(event: { type: string }) => void>>();

  readonly classList = {
    add: (className: string) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      classes.add(className);
      this.className = Array.from(classes).join(" ");
    },
  };

  constructor(readonly tagName: string) {}

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.replaceChildren(new FakeText(value));
  }

  append(...nodes: Array<FakeElement | FakeText>) {
    for (const node of nodes) {
      this.insertBefore(node, null);
    }
  }

  replaceChildren(...nodes: Array<FakeElement | FakeText>) {
    for (const child of this.children) child.parentElement = null;
    for (const child of this.childNodes) child.parentElement = null;
    this.children = [];
    this.childNodes = [];
    this.append(...nodes);
  }

  insertBefore<T extends FakeElement | FakeText>(node: T, referenceNode: FakeElement | null): T {
    node.parentElement?.removeChild(node);
    node.parentElement = this;
    const childIndex = referenceNode ? this.childNodes.indexOf(referenceNode) : -1;
    if (childIndex >= 0) {
      this.childNodes.splice(childIndex, 0, node);
    } else {
      this.childNodes.push(node);
    }
    if (node instanceof FakeElement) {
      const elementIndex = referenceNode ? this.children.indexOf(referenceNode) : -1;
      if (elementIndex >= 0) {
        this.children.splice(elementIndex, 0, node);
      } else {
        this.children.push(node);
      }
    }
    return node;
  }

  removeChild(node: FakeElement | FakeText) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    if (node instanceof FakeElement) this.children = this.children.filter((child) => child !== node);
    node.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.find((element) => matchesSelector(element, selector)) as T | null;
  }

  addEventListener(type: string, listener: (event: { type: string }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { type: string }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event: { type: string }) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  private find(predicate: (element: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  createTextNode(data: string) {
    return new FakeText(data);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  const turnIdMatch = selector.match(/^\[data-turn-id=['"](.+)['"]\]$/);
  if (turnIdMatch) return element.dataset.turnId === turnIdMatch[1];
  return false;
}

function setupDom() {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("Node", { TEXT_NODE });
  const transcriptLogEl = new FakeElement("section") as unknown as HTMLElement;
  const transcriptEl = new FakeElement("ol") as unknown as HTMLOListElement;
  return { transcriptLogEl, transcriptEl };
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  element.scrollHeight = scrollHeight;
  element.clientHeight = clientHeight;
}

function turns(count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `u${index}`,
    role: "user" as const,
    text: `turn ${index}`,
    source: "g2_text" as const,
    ts: index,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("transcript rendering", () => {
  it("sticks to the bottom when already within the bottom threshold", () => {
    const { transcriptLogEl, transcriptEl } = setupDom();
    transcriptLogEl.scrollTop = 0;
    setScrollMetrics(transcriptLogEl, 108, 100);

    renderTranscript({
      transcriptLogEl,
      transcriptEl,
      transcript: turns(5),
      userIsScrolling: false,
    });

    expect(transcriptEl.children).toHaveLength(5);
    expect(transcriptLogEl.scrollTop).toBe(8);
  });

  it("uses the post-render scroll height when sticking to the bottom", () => {
    const { transcriptLogEl, transcriptEl } = setupDom();
    transcriptLogEl.scrollTop = 0;
    transcriptLogEl.clientHeight = 100;
    let scrollHeightReads = 0;
    Object.defineProperty(transcriptLogEl, "scrollHeight", {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return scrollHeightReads === 1 ? 108 : 140;
      },
    });

    renderTranscript({
      transcriptLogEl,
      transcriptEl,
      transcript: turns(5),
      userIsScrolling: false,
    });

    expect(transcriptLogEl.scrollTop).toBe(40);
  });

  it("does not touch scrollTop while a touch scroll is active", () => {
    vi.useFakeTimers();
    const { transcriptLogEl, transcriptEl } = setupDom();
    const tracker = bindTranscriptUserScrollTracker(transcriptLogEl);
    transcriptLogEl.scrollTop = 37;
    setScrollMetrics(transcriptLogEl, 108, 100);

    transcriptLogEl.dispatchEvent({ type: "touchstart" } as Event);
    renderTranscript({
      transcriptLogEl,
      transcriptEl,
      transcript: turns(5),
      userIsScrolling: tracker.isUserScrolling(),
    });

    expect(transcriptLogEl.scrollTop).toBe(37);
    tracker.dispose();
  });

  it("leaves mid-scroll scrollTop unchanged when user is not at the bottom", () => {
    const { transcriptLogEl, transcriptEl } = setupDom();
    transcriptLogEl.scrollTop = 120;
    setScrollMetrics(transcriptLogEl, 400, 100);

    renderTranscript({
      transcriptLogEl,
      transcriptEl,
      transcript: turns(5),
      userIsScrolling: false,
    });

    expect(transcriptLogEl.scrollTop).toBe(120);
  });

  it("updates the latest streaming assistant turn in place without adding or re-inserting the node", () => {
    const { transcriptLogEl, transcriptEl } = setupDom();
    setScrollMetrics(transcriptLogEl, 400, 100);
    const transcript: Turn[] = [
      ...turns(199),
      { id: "assistant-latest", role: "assistant", text: "hello", status: "streaming", ts: 999 },
    ];

    renderTranscript({
      transcriptLogEl,
      transcriptEl,
      transcript,
      userIsScrolling: false,
    });
    const latest = transcriptEl.querySelector<HTMLLIElement>("[data-turn-id='assistant-latest']")!;
    const insertBeforeSpy = vi.spyOn(transcriptEl, "insertBefore");

    renderTranscript({
      transcriptLogEl,
      transcriptEl,
      transcript: [
        ...turns(199),
        { id: "assistant-latest", role: "assistant", text: "hello world", status: "streaming", ts: 999 },
      ],
      userIsScrolling: false,
    });

    expect(transcriptEl.children).toHaveLength(200);
    expect(transcriptEl.querySelector("[data-turn-id='assistant-latest']")).toBe(latest);
    expect(latest.querySelector(".turn-text")?.textContent).toBe("hello world▌");
    expect(insertBeforeSpy).not.toHaveBeenCalled();
  });
});
