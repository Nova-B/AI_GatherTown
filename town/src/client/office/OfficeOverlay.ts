/**
 * DOM overlay carrying every piece of UI text in the office: speech bubbles,
 * name tags and room labels.
 *
 * The text is HTML rather than Phaser Text because the canvas runs in pixel-art
 * mode. `pixelArt: true` forces `antialias: false`, which makes Phaser upload
 * every texture with NEAREST filtering - a Text object's own canvas included -
 * and stamps `image-rendering: pixelated` on the game canvas. On a display
 * scaled above 100% a glyph is then resampled twice (down by 1/devicePixelRatio
 * when the quad is drawn, up by devicePixelRatio when the browser fits the
 * canvas to physical pixels) and comes out smeared. The browser draws DOM text
 * at the device's own resolution, so labels stay sharp while the sprites keep
 * their crisp nearest-neighbour scaling.
 *
 * Coordinates are the screen-space pixels the scene already computes for the
 * former UI camera: the overlay covers the canvas exactly, so an (x, y) means
 * the same thing in both.
 */

export interface Size {
  w: number;
  h: number;
}

export interface BubbleContent {
  title: string;
  detail: string;
  /** Border and title colour (the status colour). */
  color: string;
  /** Faded because another session is selected. */
  faded: boolean;
}

export interface NameContent {
  label: string;
  color: string;
  dimmed: boolean;
}

export interface RoomLabelContent {
  title: string;
  sub: string;
  color: string;
}

const ZERO: Size = { w: 0, h: 0 };

/** An element positioned by transform, remembering its last placement. */
interface Placed {
  el: HTMLElement;
  x: number;
  y: number;
}

interface CharOverlay {
  bubble: Placed;
  bubbleTitle: HTMLElement;
  bubbleDetail: HTMLElement;
  /** Content currently rendered, so unchanged reconciles skip a re-measure. */
  bubbleSig: string;
  bubbleSize: Size;
  bubbleHasContent: boolean;
  bubbleHidden: boolean;
  name: Placed;
  nameSig: string;
  nameSize: Size;
}

interface RoomOverlay {
  label: Placed;
  title: HTMLElement;
  sub: HTMLElement;
  sig: string;
}

function el(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function place(p: Placed, x: number, y: number): void {
  if (p.x === x && p.y === y) return;
  p.x = x;
  p.y = y;
  p.el.style.transform = `translate(${x}px, ${y}px)`;
}

function measure(node: HTMLElement): Size {
  const r = node.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
}

/** `#rrggbb` to `rgba(...)`; unparseable input is passed through unchanged. */
function rgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class OfficeOverlay {
  private root: HTMLDivElement;
  private chars = new Map<string, CharOverlay>();
  private rooms: RoomOverlay[] = [];

  constructor(host: HTMLElement) {
    this.root = el('office-overlay');
    host.appendChild(this.root);
  }

  destroy(): void {
    this.chars.clear();
    this.rooms = [];
    this.root.remove();
  }

  // ---- characters -------------------------------------------------------------
  addCharacter(key: string): void {
    if (this.chars.has(key)) return;
    const bubble = el('town-bubble');
    const bubbleTitle = el('town-bubble-title');
    const bubbleDetail = el('town-bubble-detail');
    bubble.append(bubbleTitle, bubbleDetail);
    const name = el('town-nametag');
    this.root.append(bubble, name);
    this.chars.set(key, {
      bubble: { el: bubble, x: NaN, y: NaN },
      bubbleTitle,
      bubbleDetail,
      bubbleSig: '',
      bubbleSize: ZERO,
      bubbleHasContent: false,
      bubbleHidden: false,
      name: { el: name, x: NaN, y: NaN },
      nameSig: '',
      nameSize: ZERO,
    });
    this.applyBubbleVisibility(key);
  }

  removeCharacter(key: string): void {
    const c = this.chars.get(key);
    if (!c) return;
    c.bubble.el.remove();
    c.name.el.remove();
    this.chars.delete(key);
  }

  /** Sets bubble content (or clears it) and returns the box it now occupies. */
  setBubble(key: string, content: BubbleContent | null): Size {
    const c = this.chars.get(key);
    if (!c) return ZERO;
    if (!content) {
      c.bubbleHasContent = false;
      c.bubbleSig = '';
      c.bubbleSize = ZERO;
      this.applyBubbleVisibility(key);
      return ZERO;
    }
    const sig = `${content.title}\u0000${content.detail}\u0000${content.color}\u0000${content.faded}`;
    const hadContent = c.bubbleHasContent;
    c.bubbleHasContent = true;
    if (hadContent && sig === c.bubbleSig) return c.bubbleSize;
    c.bubbleSig = sig;
    c.bubbleTitle.textContent = content.title;
    c.bubbleTitle.style.color = content.color;
    c.bubbleDetail.textContent = content.detail;
    c.bubbleDetail.style.display = content.detail ? '' : 'none';
    c.bubble.el.style.borderColor = content.color;
    c.bubble.el.style.opacity = content.faded ? '0.6' : '1';
    // Measure while laid out, then restore whatever visibility was asked for.
    c.bubble.el.style.display = 'block';
    c.bubbleSize = measure(c.bubble.el);
    this.applyBubbleVisibility(key);
    return c.bubbleSize;
  }

  /** Overlap resolution hides a bubble without discarding its content or box. */
  setBubbleHidden(key: string, hidden: boolean): void {
    const c = this.chars.get(key);
    if (!c || c.bubbleHidden === hidden) return;
    c.bubbleHidden = hidden;
    this.applyBubbleVisibility(key);
  }

  private applyBubbleVisibility(key: string): void {
    const c = this.chars.get(key);
    if (!c) return;
    c.bubble.el.style.display = c.bubbleHasContent && !c.bubbleHidden ? 'block' : 'none';
  }

  placeBubble(key: string, x: number, y: number): void {
    const c = this.chars.get(key);
    if (c) place(c.bubble, x, y);
  }

  /** Sets the name tag and returns the box it now occupies. */
  setName(key: string, content: NameContent): Size {
    const c = this.chars.get(key);
    if (!c) return ZERO;
    const sig = `${content.label}\u0000${content.color}\u0000${content.dimmed}`;
    if (sig === c.nameSig) return c.nameSize;
    c.nameSig = sig;
    c.name.el.textContent = content.label;
    c.name.el.style.backgroundColor = rgba(content.color, content.dimmed ? 0.45 : 0.9);
    c.nameSize = measure(c.name.el);
    return c.nameSize;
  }

  placeName(key: string, x: number, y: number): void {
    const c = this.chars.get(key);
    if (c) place(c.name, x, y);
  }

  // ---- room labels ------------------------------------------------------------
  ensureRoomLabels(count: number): void {
    while (this.rooms.length < count) {
      const label = el('town-roomlabel');
      const title = el('town-roomlabel-title');
      const sub = el('town-roomlabel-sub');
      label.append(title, sub);
      this.root.appendChild(label);
      this.rooms.push({ label: { el: label, x: NaN, y: NaN }, title, sub, sig: '' });
    }
  }

  setRoomLabel(index: number, content: RoomLabelContent | null): void {
    const r = this.rooms[index];
    if (!r) return;
    const sig = content ? `${content.title}\u0000${content.sub}\u0000${content.color}` : '';
    if (sig === r.sig) return;
    r.sig = sig;
    if (!content || (!content.title && !content.sub)) {
      r.label.el.style.display = 'none';
      return;
    }
    r.label.el.style.display = 'block';
    r.title.textContent = content.title;
    r.title.style.color = content.color;
    r.sub.textContent = content.sub;
    r.sub.style.display = content.sub ? '' : 'none';
  }

  placeRoomLabel(index: number, x: number, y: number): void {
    const r = this.rooms[index];
    if (r) place(r.label, x, y);
  }
}
