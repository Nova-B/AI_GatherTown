/**
 * Fixed office layout: 3 x 2 project rooms ("pods"). Each pod has a lead desk,
 * three employee desks, a bookshelf corner (reading/search zone), a whiteboard
 * corner (command zone) and a sofa (waiting-for-input zone).
 *
 * Pods are assigned to sessions by creation order (stable for the life of the
 * state); the map itself never changes at runtime.
 */
export const TILE = 16;
export const COLS = 49;
export const ROWS = 31;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

export const POD_COUNT = 6;
const POD_COLS = 3;
const POD_W = 16; // including the shared left wall column
const POD_H = 15; // including the shared top wall row

export type Zone = 'desk' | 'read' | 'shell' | 'wait';

export interface TilePos {
  col: number;
  row: number;
}

export interface FurnitureSpec {
  /** Texture key (matches the asset file name without extension). */
  key: string;
  col: number;
  row: number;
  /** Footprint in tiles; the sprite is bottom-anchored to the footprint. */
  w: number;
  h: number;
  flipX?: boolean;
  /** Draw above everything (wall decor). */
  wall?: boolean;
}

export interface PodLayout {
  index: number;
  /** Interior origin (first floor tile). */
  origin: TilePos;
  /** Interior size in tiles. */
  width: number;
  height: number;
  /** Where the room label is drawn (world px). */
  labelPos: { x: number; y: number };
  /** Lead (main agent) seat. */
  leadSeat: TilePos;
  /** Employee seats, in order. */
  seats: TilePos[];
  /** Standing spots for overflow agents. */
  overflow: TilePos[];
  readSpot: TilePos;
  shellSpot: TilePos;
  waitSpot: TilePos;
  furniture: FurnitureSpec[];
  floorPattern: number;
  floorTint: number;
}

export type TileKind = 'floor' | 'wall' | 'void';

export interface OfficeLayout {
  tiles: TileKind[][];
  pods: PodLayout[];
  /** Furniture outside pods (none for now, reserved). */
  furniture: FurnitureSpec[];
}

const FLOOR_TINTS = [0xe9dcc5, 0xd9e4ea, 0xe3e6d2, 0xe6dbe4, 0xdfe7d8, 0xece0d0];
const FLOOR_PATTERNS = [1, 3, 2, 4, 6, 5];

function buildPod(index: number): PodLayout {
  const px = index % POD_COLS;
  const py = Math.floor(index / POD_COLS);
  const wallCol = px * POD_W;
  const wallRow = py * POD_H;
  const ix = wallCol + 1;
  const iy = wallRow + 1;
  const width = 15;
  const height = 14;

  const furniture: FurnitureSpec[] = [
    // Wall decor on the top wall row.
    { key: 'DOUBLE_BOOKSHELF', col: ix + 1, row: wallRow, w: 2, h: 1, wall: true },
    { key: 'BOOKSHELF', col: ix + 3, row: wallRow, w: 2, h: 1, wall: true },
    { key: index % 2 === 0 ? 'LARGE_PAINTING' : 'CLOCK', col: ix + 7, row: wallRow, w: index % 2 === 0 ? 2 : 1, h: 1, wall: true },
    { key: 'WHITEBOARD', col: ix + 11, row: wallRow, w: 2, h: 1, wall: true },
    // Lead desk with PC and chair.
    { key: 'DESK_FRONT', col: ix + 6, row: iy + 2, w: 3, h: 2 },
    { key: 'PC_FRONT_ON_1', col: ix + 7, row: iy + 1, w: 1, h: 2 },
    { key: 'WOODEN_CHAIR_BACK', col: ix + 7, row: iy + 4, w: 1, h: 1 },
    // Employee desks.
    { key: 'DESK_FRONT', col: ix + 1, row: iy + 7, w: 3, h: 2 },
    { key: 'PC_FRONT_ON_2', col: ix + 2, row: iy + 6, w: 1, h: 2 },
    { key: 'WOODEN_CHAIR_BACK', col: ix + 2, row: iy + 9, w: 1, h: 1 },
    { key: 'DESK_FRONT', col: ix + 6, row: iy + 7, w: 3, h: 2 },
    { key: 'PC_FRONT_ON_3', col: ix + 7, row: iy + 6, w: 1, h: 2 },
    { key: 'WOODEN_CHAIR_BACK', col: ix + 7, row: iy + 9, w: 1, h: 1 },
    { key: 'DESK_FRONT', col: ix + 11, row: iy + 7, w: 3, h: 2 },
    { key: 'PC_FRONT_ON_1', col: ix + 12, row: iy + 6, w: 1, h: 2 },
    { key: 'WOODEN_CHAIR_BACK', col: ix + 12, row: iy + 9, w: 1, h: 1 },
    // Decor and waiting sofa.
    { key: index % 3 === 0 ? 'LARGE_PLANT' : 'PLANT', col: ix, row: iy + 11, w: 1, h: 1 },
    { key: 'SOFA_FRONT', col: ix + 11, row: iy + 12, w: 2, h: 1 },
    { key: 'SMALL_TABLE_FRONT', col: ix + 13, row: iy + 12, w: 1, h: 1 },
    { key: 'COFFEE', col: ix + 13, row: iy + 11, w: 1, h: 1 },
    { key: index % 2 === 1 ? 'CACTUS' : 'PLANT_2', col: ix + 14, row: iy + 1, w: 1, h: 1 },
    { key: 'BIN', col: ix + 4, row: iy + 12, w: 1, h: 1 },
  ];

  return {
    index,
    origin: { col: ix, row: iy },
    width,
    height,
    // Bottom-left corner of the room, away from the desks where bubbles appear.
    labelPos: { x: (ix + 1.3) * TILE, y: (iy + 12.2) * TILE },
    leadSeat: { col: ix + 7, row: iy + 4 },
    seats: [
      { col: ix + 2, row: iy + 9 },
      { col: ix + 7, row: iy + 9 },
      { col: ix + 12, row: iy + 9 },
    ],
    overflow: [
      { col: ix + 4, row: iy + 11 },
      { col: ix + 6, row: iy + 11 },
      { col: ix + 8, row: iy + 11 },
      { col: ix + 10, row: iy + 11 },
      { col: ix + 3, row: iy + 5 },
      { col: ix + 11, row: iy + 5 },
    ],
    readSpot: { col: ix + 2, row: iy + 1 },
    shellSpot: { col: ix + 11, row: iy + 1 },
    waitSpot: { col: ix + 11, row: iy + 11 },
    furniture,
    floorPattern: FLOOR_PATTERNS[index % FLOOR_PATTERNS.length] ?? 1,
    floorTint: FLOOR_TINTS[index % FLOOR_TINTS.length] ?? 0xe9dcc5,
  };
}

export function buildLayout(): OfficeLayout {
  const tiles: TileKind[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const row: TileKind[] = [];
    for (let c = 0; c < COLS; c++) {
      const isWallCol = c === 0 || c === COLS - 1 || c % POD_W === 0;
      const isWallRow = r === 0 || r === ROWS - 1 || r % POD_H === 0;
      row.push(isWallCol || isWallRow ? 'wall' : 'floor');
    }
    tiles.push(row);
  }
  // Doorways between rooms: gaps in interior walls.
  for (let px = 1; px < POD_COLS; px++) {
    const c = px * POD_W;
    for (const r of [7, 8, 22, 23]) {
      const row = tiles[r];
      if (row) row[c] = 'floor';
    }
  }
  for (const c of [7, 8, 23, 24, 39, 40]) {
    const row = tiles[POD_H];
    if (row) row[c] = 'floor';
  }
  const pods: PodLayout[] = [];
  for (let i = 0; i < POD_COUNT; i++) pods.push(buildPod(i));
  return { tiles, pods, furniture: [] };
}

/** Bitmask N=1, E=2, S=4, W=8 following the upstream wall auto-tiling convention. */
export function wallMask(tiles: TileKind[][], col: number, row: number): number {
  const at = (c: number, r: number): boolean => tiles[r]?.[c] === 'wall';
  let m = 0;
  if (at(col, row - 1)) m |= 1;
  if (at(col + 1, row)) m |= 2;
  if (at(col, row + 1)) m |= 4;
  if (at(col - 1, row)) m |= 8;
  return m;
}
