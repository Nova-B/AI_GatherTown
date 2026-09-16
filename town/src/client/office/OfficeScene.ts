/**
 * Phaser scene for the fixed office. Receives a view model (see viewModel.ts)
 * and reconciles characters; camera fit/pan/zoom; selection.
 *
 * Two cameras: the world camera (zoom/pan) renders map and characters; a
 * second, never-zoomed UI camera renders the screen-space layer (bubbles,
 * name tags, room labels). Each camera ignores the other's objects, so UI
 * text is positioned in screen pixels exactly once.
 */
import Phaser from 'phaser';

import type { ActivityClass } from '../../shared/events.js';
import type { AgentDisplayStatus } from '../../shared/state.js';
import type { CharacterVM, OfficeVM } from '../viewModel.js';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_COUNT,
  FLOOR_COUNT,
  FURNITURE_FILES,
} from './assets.js';
import {
  buildLayout,
  type OfficeLayout,
  type PodLayout,
  TILE,
  type TilePos,
  wallMask,
  WORLD_H,
  WORLD_W,
} from './layout.js';

type Dir = 'down' | 'up' | 'right' | 'left';

const DIR_ROW: Record<Exclude<Dir, 'left'>, number> = { down: 0, up: 1, right: 2 };
const WALK_SPEED = 64; // px/s
const RETARGET_COOLDOWN_MS = 1800;
const LINK_DURATION_MS = 4000;
const SIT_OFFSET = 4;

const STATUS_COLOR: Record<AgentDisplayStatus, string> = {
  working: '#0f766e',
  awaiting_approval: '#b45309',
  waiting_input: '#6d28d9',
  failed: '#b91c1c',
  done: '#15803d',
  idle: '#475569',
  ended: '#64748b',
  unknown: '#64748b',
};

const PROVIDER_COLOR: Record<'claude' | 'codex', string> = {
  claude: '#c2410c',
  codex: '#0e7490',
};

const UI_FONT = "'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";

interface CharEntity {
  key: string;
  vm: CharacterVM;
  sprite: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  targetTile: TilePos;
  seated: boolean;
  dir: Dir;
  lastRetargetAt: number;
  spawnedAt: number;
  bubble: Phaser.GameObjects.Container;
  bubbleBg: Phaser.GameObjects.Graphics;
  bubbleTitle: Phaser.GameObjects.Text;
  bubbleDetail: Phaser.GameObjects.Text;
  bubbleW: number;
  bubbleH: number;
  /** Desired screen rect of the bubble this frame (kept even when hidden). */
  bubbleRect: { x: number; y: number; w: number; h: number };
  nameTag: Phaser.GameObjects.Text;
  nameBg: Phaser.GameObjects.Graphics;
  hidden: boolean;
}

export interface OfficeSceneCallbacks {
  onSelect(sessionKey: string | null, agentId: string | null): void;
  onReady(): void;
}

export interface CharacterSnapshot {
  key: string;
  x: number;
  y: number;
  status: string;
  bubble: string | null;
  bubbleVisible: boolean;
  /** Where the world camera projects the character's feet, in screen px. */
  screenX: number;
  screenY: number;
  /** Bubble centre-bottom and name tag top-centre in screen px (UI camera space). */
  bubbleAnchorX: number | null;
  bubbleAnchorY: number | null;
  nameAnchorX: number;
  nameAnchorY: number;
}

export class OfficeScene extends Phaser.Scene {
  private layout: OfficeLayout = buildLayout();
  private chars = new Map<string, CharEntity>();
  private vm: OfficeVM | null = null;
  private vmDirty = false;
  private worldLayer!: Phaser.GameObjects.Layer;
  private uiLayer!: Phaser.GameObjects.Layer;
  private uiCamera!: Phaser.Cameras.Scene2D.Camera;
  private roomLabels: Array<{
    title: Phaser.GameObjects.Text;
    sub: Phaser.GameObjects.Text;
    bg: Phaser.GameObjects.Graphics;
  }> = [];
  private selectionGfx!: Phaser.GameObjects.Graphics;
  private linkGfx!: Phaser.GameObjects.Graphics;
  private dragStart: { x: number; y: number; sx: number; sy: number } | null = null;
  private dragMoved = false;
  private pinchDistance: number | null = null;
  private userCamera = false;
  private reduceMotion = false;
  private lastOverlapCheck = 0;
  private callbacks: OfficeSceneCallbacks;
  private pendingFocus: { key: string } | null = null;
  ready = false;

  constructor(callbacks: OfficeSceneCallbacks) {
    super('office');
    this.callbacks = callbacks;
  }

  /** Test/diagnostic accessor: number of character sprites currently in the office. */
  characterCount(): number {
    return this.chars.size;
  }

  /** Test/diagnostic accessor: positions in world and screen space. */
  characterSnapshot(): CharacterSnapshot[] {
    const cam = this.cameras.main;
    return [...this.chars.values()].map((e) => {
      const sy = e.seated ? -SIT_OFFSET : 0;
      const nw = e.nameTag.width + 8;
      return {
        key: e.key,
        x: e.x,
        y: e.y,
        status: e.vm.status,
        bubble: e.vm.bubble ? e.vm.bubble.title : null,
        bubbleVisible: e.bubble.visible,
        screenX: (e.x - cam.worldView.x) * cam.zoom,
        screenY: (e.y + sy - cam.worldView.y) * cam.zoom,
        bubbleAnchorX: e.vm.bubble ? e.bubble.x + e.bubbleW / 2 : null,
        bubbleAnchorY: e.vm.bubble ? e.bubble.y + e.bubbleH : null,
        nameAnchorX: e.nameBg.x + nw / 2,
        nameAnchorY: e.nameBg.y,
      };
    });
  }

  cameraZoom(): number {
    return this.cameras.main.zoom;
  }

  preload(): void {
    for (let i = 0; i < FLOOR_COUNT; i++) this.load.image(`floor_${i}`, `/assets/floors/floor_${i}.png`);
    this.load.spritesheet('wall_0', '/assets/walls/wall_0.png', { frameWidth: 16, frameHeight: 32 });
    for (let i = 0; i < CHARACTER_COUNT; i++) {
      this.load.spritesheet(`char_${i}`, `/assets/characters/char_${i}.png`, {
        frameWidth: CHAR_FRAME_W,
        frameHeight: CHAR_FRAME_H,
      });
    }
    for (const [key, file] of Object.entries(FURNITURE_FILES)) {
      this.load.image(key, `/assets/furniture/${file}`);
    }
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#23262f');
    this.worldLayer = this.add.layer();
    this.uiLayer = this.add.layer();
    this.uiLayer.setDepth(10000);
    this.buildMap();
    this.buildAnimations();
    this.selectionGfx = this.add.graphics().setDepth(9000);
    this.linkGfx = this.add.graphics().setDepth(8990);
    this.worldLayer.add([this.selectionGfx, this.linkGfx]);
    this.buildRoomLabels();
    this.setupCameras();
    this.setupInput();
    this.scale.on('resize', () => {
      this.uiCamera.setSize(this.scale.width, this.scale.height);
      if (!this.userCamera) this.fitCamera();
    });
    this.ready = true;
    this.callbacks.onReady();
    if (this.vm) this.reconcile(this.vm);
  }

  // ---- map --------------------------------------------------------------------
  private buildMap(): void {
    const { tiles, pods } = this.layout;
    const podAt = (col: number, row: number): PodLayout | null => {
      for (const p of pods) {
        if (
          col >= p.origin.col &&
          col < p.origin.col + p.width &&
          row >= p.origin.row &&
          row < p.origin.row + p.height
        )
          return p;
      }
      return null;
    };
    for (let r = 0; r < tiles.length; r++) {
      const row = tiles[r]!;
      for (let c = 0; c < row.length; c++) {
        const kind = row[c];
        if (kind === 'floor') {
          const pod = podAt(c, r);
          const pattern = pod ? pod.floorPattern : 0;
          const tint = pod ? pod.floorTint : 0xd6d3cd;
          const img = this.add
            .image(c * TILE, r * TILE, `floor_${pattern}`)
            .setOrigin(0, 0)
            .setTint(tint)
            .setDepth(0);
          this.worldLayer.add(img);
        } else if (kind === 'wall') {
          const mask = wallMask(tiles, c, r);
          const img = this.add
            .image(c * TILE, (r + 1) * TILE, 'wall_0', mask)
            .setOrigin(0, 1)
            .setTint(0x8d94a6)
            .setDepth((r + 1) * TILE);
          this.worldLayer.add(img);
        }
      }
    }
    for (const pod of pods) {
      for (const f of pod.furniture) {
        const bottom = (f.row + f.h) * TILE;
        const img = this.add
          .image(f.col * TILE, bottom, f.key)
          .setOrigin(0, 1)
          .setDepth(f.wall ? bottom + 1 : bottom + 0.5);
        if (f.flipX) img.setFlipX(true);
        this.worldLayer.add(img);
      }
    }
  }

  private buildAnimations(): void {
    for (let i = 0; i < CHARACTER_COUNT; i++) {
      const key = `char_${i}`;
      for (const dir of ['down', 'up', 'right'] as const) {
        const base = DIR_ROW[dir] * CHAR_FRAMES_PER_ROW;
        this.anims.create({
          key: `${key}-walk-${dir}`,
          frames: [base, base + 1, base + 2, base + 1].map((f) => ({ key, frame: f })),
          frameRate: 7,
          repeat: -1,
        });
        this.anims.create({
          key: `${key}-type-${dir}`,
          frames: [base + 3, base + 4].map((f) => ({ key, frame: f })),
          frameRate: 3,
          repeat: -1,
        });
        this.anims.create({
          key: `${key}-read-${dir}`,
          frames: [base + 5, base + 6].map((f) => ({ key, frame: f })),
          frameRate: 2,
          repeat: -1,
        });
      }
    }
  }

  private uiText(size: string, color: string, style = ''): Phaser.GameObjects.Text {
    const t = this.add.text(0, 0, '', {
      fontFamily: UI_FONT,
      fontSize: size,
      fontStyle: style,
      color,
      resolution: window.devicePixelRatio || 1,
    });
    this.uiLayer.add(t);
    return t;
  }

  private uiGraphics(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    this.uiLayer.add(g);
    return g;
  }

  private buildRoomLabels(): void {
    for (let i = 0; i < this.layout.pods.length; i++) {
      const bg = this.uiGraphics();
      const title = this.uiText('12px', '#1f2937', '600');
      const sub = this.uiText('10px', '#4b5563');
      this.roomLabels.push({ title, sub, bg });
    }
  }

  // ---- cameras ----------------------------------------------------------------
  private setupCameras(): void {
    const main = this.cameras.main;
    main.setRoundPixels(true);
    this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, 'ui');
    this.uiCamera.setScroll(0, 0);
    this.uiCamera.setZoom(1);
    this.uiCamera.setRoundPixels(true);
    // The world camera never draws UI objects; the UI camera never draws world objects.
    main.ignore(this.uiLayer);
    this.uiCamera.ignore(this.worldLayer);
    this.fitCamera();
  }

  fitCamera(): void {
    const cam = this.cameras.main;
    const w = this.scale.width;
    const h = this.scale.height;
    const zoom = Math.max(0.6, Math.min(4, Math.min(w / (WORLD_W + 24), h / (WORLD_H + 40))));
    cam.setZoom(Math.floor(zoom * 8) / 8);
    cam.centerOn(WORLD_W / 2, WORLD_H / 2 - 6);
    this.userCamera = false;
  }

  zoomBy(factor: number, pointer?: { x: number; y: number }): void {
    const cam = this.cameras.main;
    const before = pointer ? cam.getWorldPoint(pointer.x, pointer.y) : null;
    const next = Math.max(0.5, Math.min(6, cam.zoom * factor));
    cam.setZoom(next);
    if (before && pointer) {
      const after = cam.getWorldPoint(pointer.x, pointer.y);
      cam.scrollX += before.x - after.x;
      cam.scrollY += before.y - after.y;
    }
    this.userCamera = true;
  }

  focusCharacter(key: string): void {
    const e = this.chars.get(key);
    if (!e) {
      this.pendingFocus = { key };
      return;
    }
    const cam = this.cameras.main;
    if (cam.zoom < 2.5) cam.setZoom(2.5);
    cam.pan(e.x, e.y - 8, this.reduceMotion ? 0 : 350, 'Sine.easeInOut');
    this.userCamera = true;
  }

  focusPod(podIndex: number): void {
    const pod = this.layout.pods[podIndex];
    if (!pod) return;
    const cam = this.cameras.main;
    if (cam.zoom < 2) cam.setZoom(2);
    cam.pan(
      (pod.origin.col + pod.width / 2) * TILE,
      (pod.origin.row + pod.height / 2) * TILE,
      this.reduceMotion ? 0 : 350,
      'Sine.easeInOut',
    );
    this.userCamera = true;
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
  }

  private setupInput(): void {
    this.input.addPointer(1); // two-finger pinch on touch devices
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.dragStart = { x: p.x, y: p.y, sx: this.cameras.main.scrollX, sy: this.cameras.main.scrollY };
      this.dragMoved = false;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (this.pinchDistance !== null && this.pinchDistance > 0) {
          this.zoomBy(dist / this.pinchDistance, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
        }
        this.pinchDistance = dist;
        this.dragMoved = true;
        return;
      }
      this.pinchDistance = null;
      if (!this.dragStart || !p.isDown) return;
      const dx = p.x - this.dragStart.x;
      const dy = p.y - this.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.dragMoved = true;
      if (this.dragMoved) {
        const cam = this.cameras.main;
        cam.scrollX = this.dragStart.sx - dx / cam.zoom;
        cam.scrollY = this.dragStart.sy - dy / cam.zoom;
        this.userCamera = true;
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer, targets: Phaser.GameObjects.GameObject[]) => {
      const wasDrag = this.dragMoved;
      this.dragStart = null;
      this.dragMoved = false;
      if (wasDrag) return;
      const hit = targets.find((t) => (t as Phaser.GameObjects.Sprite).getData?.('charKey'));
      if (hit) {
        const key = (hit as Phaser.GameObjects.Sprite).getData('charKey') as string;
        const e = this.chars.get(key);
        if (e) this.callbacks.onSelect(e.vm.sessionKey, e.vm.agentId);
        return;
      }
      const world = this.cameras.main.getWorldPoint(p.x, p.y);
      const pod = this.layout.pods.find(
        (pd) =>
          world.x >= pd.origin.col * TILE &&
          world.x < (pd.origin.col + pd.width) * TILE &&
          world.y >= pd.origin.row * TILE &&
          world.y < (pd.origin.row + pd.height) * TILE,
      );
      const room = pod ? this.vm?.rooms[pod.index] : undefined;
      this.callbacks.onSelect(room?.sessionKey ?? null, null);
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
      this.zoomBy(dy > 0 ? 1 / 1.15 : 1.15, { x: p.x, y: p.y });
    });
  }

  // ---- view model -------------------------------------------------------------
  setViewModel(vm: OfficeVM): void {
    this.vm = vm;
    this.vmDirty = true;
    if (this.ready) this.reconcile(vm);
  }

  private reconcile(vm: OfficeVM): void {
    this.vmDirty = false;
    const seen = new Set<string>();
    for (const c of vm.characters) {
      seen.add(c.key);
      let e = this.chars.get(c.key);
      if (!e) {
        e = this.spawn(c);
        this.chars.set(c.key, e);
      }
      e.vm = c;
      this.retarget(e, this.time.now);
      this.updateBubbleContent(e);
    }
    for (const [key, e] of this.chars) {
      if (!seen.has(key)) {
        e.sprite.destroy();
        e.bubble.destroy();
        e.nameTag.destroy();
        e.nameBg.destroy();
        this.chars.delete(key);
      }
    }
    for (let i = 0; i < this.roomLabels.length; i++) {
      const room = vm.rooms[i];
      const lbl = this.roomLabels[i]!;
      lbl.title.setText(room ? room.title : '');
      lbl.sub.setText(room ? room.subtitle : '');
      lbl.title.setColor(room?.provider ? PROVIDER_COLOR[room.provider] : '#6b7280');
    }
    if (this.pendingFocus && this.chars.has(this.pendingFocus.key)) {
      const k = this.pendingFocus.key;
      this.pendingFocus = null;
      this.focusCharacter(k);
    }
  }

  private spawn(c: CharacterVM): CharEntity {
    const tile = this.homeTile(c);
    const x = (tile.col + 0.5) * TILE;
    const y = (tile.row + 1) * TILE;
    const sprite = this.add
      .sprite(x, y, `char_${c.characterIndex % CHARACTER_COUNT}`, 0)
      .setOrigin(0.5, 1)
      .setDepth(y);
    sprite.setInteractive({ useHandCursor: true });
    sprite.setData('charKey', c.key);
    this.worldLayer.add(sprite);
    const bubbleBg = this.add.graphics();
    const bubbleTitle = this.add.text(0, 0, '', {
      fontFamily: UI_FONT,
      fontSize: '12px',
      fontStyle: '600',
      color: '#111827',
      resolution: window.devicePixelRatio || 1,
    });
    const bubbleDetail = this.add.text(0, 0, '', {
      fontFamily: UI_FONT,
      fontSize: '11px',
      color: '#374151',
      resolution: window.devicePixelRatio || 1,
    });
    const bubble = this.add.container(0, 0, [bubbleBg, bubbleTitle, bubbleDetail]);
    this.uiLayer.add(bubble);
    const nameBg = this.uiGraphics();
    const nameTag = this.uiText('10px', '#ffffff');
    nameTag.setText(c.label);
    const now = this.time.now;
    return {
      key: c.key,
      vm: c,
      sprite,
      x,
      y,
      targetX: x,
      targetY: y,
      targetTile: tile,
      seated: true,
      dir: 'down',
      lastRetargetAt: 0,
      spawnedAt: now,
      bubble,
      bubbleBg,
      bubbleTitle,
      bubbleDetail,
      bubbleW: 0,
      bubbleH: 0,
      bubbleRect: { x: 0, y: 0, w: 0, h: 0 },
      nameTag,
      nameBg,
      hidden: false,
    };
  }

  private podFor(c: CharacterVM): PodLayout | null {
    return this.layout.pods[c.podIndex] ?? null;
  }

  private homeTile(c: CharacterVM): TilePos {
    const pod = this.podFor(c);
    if (!pod) return { col: 2, row: 2 };
    if (c.seatIndex < 0) return pod.leadSeat;
    const seat = pod.seats[c.seatIndex];
    if (seat) return seat;
    const ov = pod.overflow[(c.seatIndex - pod.seats.length) % pod.overflow.length];
    return ov ?? pod.leadSeat;
  }

  private zoneTile(c: CharacterVM): { tile: TilePos; seated: boolean } {
    const pod = this.podFor(c);
    if (!pod) return { tile: this.homeTile(c), seated: true };
    const slot = c.seatIndex < 0 ? 0 : (c.seatIndex + 1) % 3;
    if (c.status === 'waiting_input') {
      return { tile: { col: pod.waitSpot.col + (slot % 2), row: pod.waitSpot.row }, seated: false };
    }
    if (c.status === 'working' && c.activity) {
      const a: ActivityClass = c.activity;
      if (a === 'read' || a === 'search') {
        return { tile: { col: pod.readSpot.col + slot, row: pod.readSpot.row }, seated: false };
      }
      if (a === 'shell') {
        return { tile: { col: pod.shellSpot.col + slot, row: pod.shellSpot.row }, seated: false };
      }
    }
    return { tile: this.homeTile(c), seated: true };
  }

  private retarget(e: CharEntity, now: number): void {
    const { tile, seated } = this.zoneTile(e.vm);
    if (tile.col === e.targetTile.col && tile.row === e.targetTile.row) return;
    if (!this.reduceMotion && now - e.lastRetargetAt < RETARGET_COOLDOWN_MS) return;
    e.targetTile = tile;
    e.targetX = (tile.col + 0.5) * TILE;
    e.targetY = (tile.row + 1) * TILE;
    e.seated = seated;
    e.lastRetargetAt = now;
    if (this.reduceMotion) {
      e.x = e.targetX;
      e.y = e.targetY;
    }
  }

  private updateBubbleContent(e: CharEntity): void {
    const c = e.vm;
    const b = c.bubble;
    const color = STATUS_COLOR[c.status];
    if (!b) {
      e.bubble.setVisible(false);
      e.bubbleW = 0;
      e.bubbleH = 0;
    } else {
      e.bubble.setVisible(!e.hidden);
      const title = b.extra > 0 ? `${b.title}  +${b.extra}` : b.title;
      e.bubbleTitle.setText(title);
      e.bubbleTitle.setColor(color);
      e.bubbleDetail.setText(b.detail ?? '');
      const maxW = 240;
      e.bubbleTitle.setWordWrapWidth(maxW, true);
      e.bubbleDetail.setWordWrapWidth(maxW, true);
      const pad = 6;
      const w = Math.min(maxW + pad * 2, Math.max(e.bubbleTitle.width, e.bubbleDetail.width) + pad * 2);
      const h = e.bubbleTitle.height + (b.detail ? e.bubbleDetail.height + 1 : 0) + pad * 2 - 2;
      e.bubbleW = w;
      e.bubbleH = h;
      e.bubbleTitle.setPosition(pad, pad - 1);
      e.bubbleDetail.setPosition(pad, pad - 1 + e.bubbleTitle.height + 1);
      e.bubbleBg.clear();
      e.bubbleBg.fillStyle(0xffffff, 0.96);
      e.bubbleBg.lineStyle(1.5, Phaser.Display.Color.HexStringToColor(color).color, 1);
      e.bubbleBg.fillRoundedRect(0, 0, w, h, 4);
      e.bubbleBg.strokeRoundedRect(0, 0, w, h, 4);
      e.bubbleBg.fillTriangle(w / 2 - 4, h, w / 2 + 4, h, w / 2, h + 5);
    }
    e.nameTag.setText(c.label);
    e.nameBg.clear();
    const nw = e.nameTag.width + 8;
    const nh = e.nameTag.height + 2;
    const tagColor = Phaser.Display.Color.HexStringToColor(c.tagColor || PROVIDER_COLOR[c.provider]).color;
    e.nameBg.fillStyle(tagColor, c.dimmed ? 0.45 : 0.9);
    e.nameBg.fillRoundedRect(0, 0, nw, nh, 3);
    e.sprite.setAlpha(c.dimmed ? 0.55 : 1);
    e.bubble.setAlpha(c.dimmed && !c.selected ? 0.6 : 1);
  }

  // ---- per-frame --------------------------------------------------------------
  update(time: number, delta: number): void {
    if (this.vmDirty && this.vm) this.reconcile(this.vm);
    const cam = this.cameras.main;
    const zoom = cam.zoom;
    const dt = delta / 1000;
    for (const e of this.chars.values()) {
      this.retarget(e, time);
      this.step(e, dt);
      const sy = e.seated ? -SIT_OFFSET : 0;
      e.sprite.setPosition(Math.round(e.x), Math.round(e.y + sy));
      e.sprite.setDepth(e.y + (e.seated ? 0.6 : 0.7));
      // Screen-space UI, projected once through the world camera.
      const sxp = (e.x - cam.worldView.x) * zoom;
      const syp = (e.y + sy - cam.worldView.y) * zoom;
      const bx = Math.round(sxp - e.bubbleW / 2);
      const by = Math.round(syp - CHAR_FRAME_H * zoom - e.bubbleH - 6);
      e.bubbleRect = { x: bx, y: by, w: e.bubbleW, h: e.bubbleH };
      e.bubble.setPosition(bx, by); // always, so hidden bubbles can reappear in place
      const nw = e.nameTag.width + 8;
      e.nameBg.setPosition(Math.round(sxp - nw / 2), Math.round(syp + 2));
      e.nameTag.setPosition(Math.round(sxp - nw / 2 + 4), Math.round(syp + 3));
    }
    this.drawSelectionAndLinks(time);
    this.layoutRoomLabels();
    if (time - this.lastOverlapCheck > 120) {
      this.lastOverlapCheck = time;
      this.resolveOverlaps();
    }
  }

  private step(e: CharEntity, dt: number): void {
    const dx = e.targetX - e.x;
    const dy = e.targetY - e.y;
    const dist = Math.hypot(dx, dy);
    const anim = (kind: 'walk' | 'type' | 'read', dir: Dir): void => {
      const texKey = e.sprite.texture.key;
      const d = dir === 'left' ? 'right' : dir;
      e.sprite.setFlipX(dir === 'left');
      const key = `${texKey}-${kind}-${d}`;
      if (e.sprite.anims.currentAnim?.key !== key) e.sprite.play(key, true);
    };
    if (dist > 1) {
      const stepLen = Math.min(dist, WALK_SPEED * dt);
      e.x += (dx / dist) * stepLen;
      e.y += (dy / dist) * stepLen;
      if (Math.abs(dx) > Math.abs(dy)) e.dir = dx > 0 ? 'right' : 'left';
      else e.dir = dy > 0 ? 'down' : 'up';
      anim('walk', e.dir);
      return;
    }
    e.x = e.targetX;
    e.y = e.targetY;
    const c = e.vm;
    if (c.status === 'working') {
      if (c.activity === 'read' || c.activity === 'search') {
        e.dir = 'up';
        anim('read', 'up');
      } else if (c.activity) {
        e.dir = 'up';
        anim('type', 'up');
      } else {
        // Response in progress without an observed tool: seated, facing the desk.
        e.dir = 'up';
        this.setIdleFrame(e, 'up');
      }
      return;
    }
    e.dir = 'down';
    this.setIdleFrame(e, 'down');
  }

  private setIdleFrame(e: CharEntity, dir: Dir): void {
    e.sprite.anims.stop();
    e.sprite.setFlipX(dir === 'left');
    const d = dir === 'left' ? 'right' : dir;
    e.sprite.setFrame(DIR_ROW[d] * CHAR_FRAMES_PER_ROW);
  }

  private drawSelectionAndLinks(time: number): void {
    this.selectionGfx.clear();
    this.linkGfx.clear();
    for (const e of this.chars.values()) {
      const sy = e.seated ? -SIT_OFFSET : 0;
      if (e.vm.selected) {
        this.selectionGfx.lineStyle(1, 0xffffff, 1);
        this.selectionGfx.strokeRect(Math.round(e.x) - 9, Math.round(e.y + sy) - 33, 18, 35);
        this.selectionGfx.lineStyle(1, 0x111827, 0.6);
        this.selectionGfx.strokeRect(Math.round(e.x) - 10, Math.round(e.y + sy) - 34, 20, 37);
      }
      // Link line only for a KNOWN immediate parent (never inferred).
      if (e.vm.parentKey && (time - e.spawnedAt < LINK_DURATION_MS || e.vm.selected)) {
        const parent = this.chars.get(e.vm.parentKey);
        if (parent) {
          const alpha = e.vm.selected ? 0.8 : Math.max(0.15, 1 - (time - e.spawnedAt) / LINK_DURATION_MS);
          this.linkGfx.lineStyle(1, 0x2563eb, alpha);
          this.linkGfx.lineBetween(parent.x, parent.y - 12, e.x, e.y + sy - 12);
        }
      }
    }
  }

  private layoutRoomLabels(): void {
    const cam = this.cameras.main;
    const zoom = cam.zoom;
    this.layout.pods.forEach((pod, i) => {
      const lbl = this.roomLabels[i];
      if (!lbl) return;
      const sx = (pod.labelPos.x - cam.worldView.x) * zoom;
      const sy = (pod.labelPos.y - cam.worldView.y) * zoom;
      const w = Math.max(lbl.title.width, lbl.sub.width) + 10;
      const h = lbl.title.height + lbl.sub.height + 4;
      lbl.bg.clear();
      lbl.bg.fillStyle(0xffffff, 0.82);
      lbl.bg.fillRoundedRect(Math.round(sx), Math.round(sy), w, h, 3);
      lbl.title.setPosition(Math.round(sx) + 5, Math.round(sy) + 1);
      lbl.sub.setPosition(Math.round(sx) + 5, Math.round(sy) + 1 + lbl.title.height);
    });
  }

  /** Hide lower-priority bubbles that overlap higher-priority ones (current rects). */
  private resolveOverlaps(): void {
    const prio = (c: CharacterVM): number => {
      if (c.selected) return 0;
      if (c.status === 'awaiting_approval') return 1;
      if (c.status === 'failed') return 2;
      if (c.status === 'working') return 3;
      return 4;
    };
    const list = [...this.chars.values()].filter((e) => e.vm.bubble);
    list.sort((a, b) => prio(a.vm) - prio(b.vm));
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const e of list) {
      const r = e.bubbleRect;
      const overlaps = placed.some(
        (p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y,
      );
      const hide = overlaps && !e.vm.selected;
      if (hide !== e.hidden) {
        e.hidden = hide;
        e.bubble.setVisible(!hide);
      }
      if (!hide) placed.push(r);
    }
  }
}
