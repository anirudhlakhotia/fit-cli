// Each letter as a fixed-width 6-row block (display columns, not bytes).
// join("  ") between blocks gives 2-col gaps; all blocks padded to their own width.
const F    = ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     ", "╚═╝     "];
const I    = ["██╗",      "██║",      "██║",      "██║",      "██║",      "╚═╝"     ];
const T    = ["████████╗","╚══██╔══╝","   ██║   ","   ██║   ","   ██║   ","   ╚═╝   "];
const DASH = ["     ",    "     ",    " ─── ",    " ─── ",    "     ",    "     "   ];
const C    = [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"];
const L    = ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"];

const LOGO_LINES = Array.from({ length: 6 }, (_, i) =>
  [F, I, T, DASH, C, L, I].map((ch) => ch[i]).join("  "),
);

// Vertical gradient: bright cyan at top → vibrant magenta at bottom
const GRADIENT: [number, number, number][] = [
  [0,   229, 255],
  [48,  188, 255],
  [96,  147, 255],
  [144, 106, 255],
  [192,  65, 255],
  [240,  24, 255],
];

export function printLogo(tagline: string): void {
  process.stdout.write("\n");
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const [r, g, b] = GRADIENT[i];
    process.stdout.write(`\x1b[38;2;${r};${g};${b}m  ${LOGO_LINES[i]}\x1b[0m\n`);
  }
  process.stdout.write(`\n  \x1b[2m${tagline}\x1b[0m\n\n`);
}
