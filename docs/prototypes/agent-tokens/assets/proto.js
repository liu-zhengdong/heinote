/* Agent 令牌身份原型共享脚本。三个方向共用数据、图标、预设与表单块。 */

"use strict";

/* ---- Lucide 图标（路径取自 lucide-react v1.31.0 包内 iconNode）---- */
const L = {
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  trash: [["path", { d: "M10 11v6" }], ["path", { d: "M14 11v6" }], ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }], ["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }]],
  copy: [["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
  key: [["path", { d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" }], ["circle", { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor" }]],
  pencil: [["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }], ["path", { d: "m15 5 4 4" }]],
  x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  chevronRight: [["path", { d: "m9 18 6-6-6-6" }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  upload: [["path", { d: "M12 3v12" }], ["path", { d: "m17 8-5-5-5 5" }], ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }]],
  fileText: [["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }], ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }], ["path", { d: "M10 9H8" }], ["path", { d: "M16 13H8" }], ["path", { d: "M16 17H8" }]],
  squarePen: [["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }], ["path", { d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" }]],
  flag: [["path", { d: "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" }]],
  rotateCcw: [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }]],
  database: [["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }], ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5" }], ["path", { d: "M3 12A9 3 0 0 0 21 12" }]],
  bot: [["path", { d: "M12 8V4H8" }], ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }], ["path", { d: "M2 14h2" }], ["path", { d: "M20 14h2" }], ["path", { d: "M15 13v2" }], ["path", { d: "M9 13v2" }]],
  sun: [["circle", { cx: "12", cy: "12", r: "4" }], ["path", { d: "M12 2v2" }], ["path", { d: "M12 20v2" }], ["path", { d: "m4.93 4.93 1.41 1.41" }], ["path", { d: "m17.66 17.66 1.41 1.41" }], ["path", { d: "M2 12h2" }], ["path", { d: "M20 12h2" }], ["path", { d: "m6.34 17.66-1.41 1.41" }], ["path", { d: "m19.07 4.93-1.41 1.41" }]],
  moon: [["path", { d: "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" }]],
  user: [["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" }], ["circle", { cx: "12", cy: "7", r: "4" }]],
  settings: [["circle", { cx: "12", cy: "12", r: "3" }], ["path", { d: "M12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1m11.4-11.4 2.1-2.1" }]],
  users: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }], ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }]],
  invite: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M19 8v6" }], ["path", { d: "M22 11h-6" }]],
  sparkles: [["path", { d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" }], ["path", { d: "M20 2v4" }], ["path", { d: "M22 4h-4" }], ["circle", { cx: "4", cy: "20", r: "2" }]],
  history: [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }], ["path", { d: "M12 7v5l4 2" }]],
};

function icon(name, size = 15) {
  const parts = L[name] || [];
  const inner = parts.map(([tag, attrs]) => {
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<${tag} ${a}/>`;
  }).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/* ---- Agent 预设：官方品牌标 + 品牌底色 + 默认名称 ----
   路径取自 visual-design 技能 brand-icons 归档（官方或交叉核对源），24x24 viewBox。 */
const LOGOS = {
  claude: { vb: "0 0 24 24", d: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" },
  codex: { vb: "0 0 24 24", d: "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" },
  gpt: { vb: "0 0 24 24", inner: `<g transform="translate(-0.6189 -0.6126) scale(1.261261)"><path d="M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z"/></g>` },
  gemini: { vb: "0 0 24 24", d: "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" },
  cursor: { vb: "0 0 24 24", d: "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" },
  deepseek: { vb: "-8 -16 88 88", inner: `<path transform="translate(-452.83 -271.91)" d="M523.77,276.34c-.76-.38-1.08.33-1.53.69a4,4,0,0,0-.41.41,5.07,5.07,0,0,1-4.1,1.87,8,8,0,0,0-6.46,2.53,5.82,5.82,0,0,0-3.72-4.62,6.39,6.39,0,0,1-2.85-1.94,7.76,7.76,0,0,1-.92-2.31c-.16-.48-.32-1-.87-1.05s-.83.41-1.07.82a11,11,0,0,0-1.26,5.5,11.9,11.9,0,0,0,5.49,10.14.75.75,0,0,1,.39,1c-.25.84-.54,1.65-.79,2.49-.17.53-.41.65-1,.42a16.63,16.63,0,0,1-5.18-3.52c-2.56-2.48-4.88-5.21-7.76-7.35-.68-.5-1.36-1-2.06-1.41-2.94-2.86.39-5.2,1.16-5.48s.28-1.29-2.33-1.28-5,.88-8,2a8.23,8.23,0,0,1-1.39.41,28.67,28.67,0,0,0-8.61-.3,18.57,18.57,0,0,0-13.44,7.83c-4,5.47-4.91,11.67-3.76,18.15a27.68,27.68,0,0,0,10,16.88,26.8,26.8,0,0,0,19.23,6.39c4.43-.25,9.36-.84,14.92-5.55a13.84,13.84,0,0,0,5.32,1.18,17.24,17.24,0,0,0,5.09-.38c2.2-.46,2.05-2.5,1.25-2.87-6.43-3-5-1.78-6.3-2.77,3.27-3.87,8.2-7.89,10.13-20.92a12.44,12.44,0,0,0,0-2.52c0-.51.1-.71.68-.76a12.55,12.55,0,0,0,4.62-1.42c4.17-2.28,5.85-6,6.25-10.51A1.57,1.57,0,0,0,523.77,276.34Zm-36.34,40.37c-6.24-4.9-9.27-6.52-10.52-6.45s-1,1.41-.7,2.28a8.49,8.49,0,0,0,1.11,2.21,1.14,1.14,0,0,1-.34,1.8c-2,1.24-5.5-.42-5.66-.5a26.08,26.08,0,0,1-9.87-9.88,30.15,30.15,0,0,1-3.87-13.39c-.06-1.15.28-1.56,1.42-1.77a14.31,14.31,0,0,1,4.57-.11,28.56,28.56,0,0,1,16.33,8.29,54.06,54.06,0,0,1,6.58,8.63,41.46,41.46,0,0,0,7.41,8.71,24.36,24.36,0,0,0,2.66,2C494.16,318.82,490.16,318.87,487.43,316.71Zm3-19.23a.92.92,0,0,1,.92-.92.83.83,0,0,1,.32.06.8.8,0,0,1,.34.22.9.9,0,0,1,.25.64.92.92,0,0,1-1.83,0Zm9.29,4.76a5.27,5.27,0,0,1-1.77.48,3.75,3.75,0,0,1-2.38-.76,3.57,3.57,0,0,1-1.65-2.26,5.16,5.16,0,0,1,0-1.76,2,2,0,0,0-.71-2.17,3.1,3.1,0,0,0-2.06-.59,1.63,1.63,0,0,1-.76-.24.75.75,0,0,1-.34-1.07,3.47,3.47,0,0,1,.57-.62,3.9,3.9,0,0,1,3.43,0,10,10,0,0,1,3,2.34,18.62,18.62,0,0,1,2,2.73,10.9,10.9,0,0,1,1.33,2.53C500.65,301.47,500.4,302,499.71,302.24Z"/>` },
};

function logoSvg(id) {
  const L = LOGOS[id];
  if (!L) return "";
  const body = L.inner || `<path d="${L.d}"/>`;
  return `<svg viewBox="${L.vb}" fill="currentColor" fill-rule="evenodd" aria-hidden="true">${body}</svg>`;
}

const PRESETS = [
  { id: "claude", name: "Claude", bg: "#d97757", fg: "#fff" },
  { id: "codex", name: "Codex", bg: "#eceef1", fg: "#111" },
  { id: "gpt", name: "ChatGPT", bg: "#10a37f", fg: "#fff" },
  { id: "gemini", name: "Gemini", bg: "#1c4fd8", fg: "#fff" },
  { id: "cursor", name: "Cursor", bg: "#111214", fg: "#fff" },
  { id: "deepseek", name: "DeepSeek", bg: "#4d6bfe", fg: "#fff" },
];


const ACTIONS = {
  edit: { label: "修改", color: "var(--blue)" },
  create: { label: "创建", color: "var(--green)" },
  propose: { label: "提案", color: "#9065b0" },
  checkpoint: { label: "检查点", color: "#cb912f" },
  restore: { label: "恢复", color: "var(--danger)" },
  database: { label: "数据库", color: "var(--green)" },
};

const TOKENS = [
  {
    id: "t1", name: "Claude", access: "write",
    created: "2026/11/10", lastUsed: "14 分钟前",
    avatar: { kind: "preset", preset: "claude" },
    activity: [
      { action: "edit", page: "周会纪要 11-10", time: "14:07" },
      { action: "checkpoint", page: "周会纪要 11-10", time: "14:06" },
      { action: "edit", page: "产品路线图草稿", time: "11:52" },
      { action: "create", page: "产品路线图草稿", time: "11:50" },
      { action: "propose", page: "发布说明 v0.9", time: "09:31" },
    ],
  },
  {
    id: "t2", name: "Codex", access: "write",
    created: "2026/11/10", lastUsed: "3 小时前",
    avatar: { kind: "preset", preset: "codex" },
    activity: [
      { action: "database", page: "缺陷追踪", time: "11:20" },
      { action: "edit", page: "缺陷追踪", time: "11:18" },
      { action: "restore", page: "接口契约", time: "10:02" },
    ],
  },
  {
    id: "t3", name: "研究笔记", access: "read",
    created: "2026/11/10", lastUsed: "昨天 22:41",
    avatar: { kind: "initial", text: "研", color: "#9065b0" },
    activity: [],
  },
];

/* ---- 渲染助手 ---- */
function avatarHtml(t, size = 28) {
  if (t.avatar && t.avatar.kind === "preset") {
    const p = PRESETS.find(p => p.id === t.avatar.preset);
    return `<span class="agent-avatar" style="--av:${size}px;background:${p.bg};color:${p.fg}">${logoSvg(p.id)}</span>`;
  }
  const text = t.avatar?.text || (t.name || "?").slice(0, 1);
  const color = t.avatar?.color || "#8a877f";
  return `<span class="agent-avatar agent-avatar--initial" style="--av:${size}px;--av-bg:${color}">${text}</span>`;
}

function accessTag(access) {
  return `<span class="tag">${access === "write" ? "读写" : "只读"}</span>`;
}

function feedHtml(token, limit = 8) {
  if (!token.activity.length) return `<p class="feed__empty">还没有写操作。该令牌执行修改后会出现在这里。</p>`;
  const rows = token.activity.slice(0, limit).map(e => {
    const a = ACTIONS[e.action];
    return `<div class="feed__item">
      <span class="feed__dot" style="background:${a.color}"></span>
      <span class="feed__act">${a.label}</span>
      <a class="feed__page" href="#" data-page>${e.page}</a>
      <span class="feed__time">${e.time}</span>
    </div>`;
  }).join("");
  const more = token.activity.length > limit ? `<p class="feed__more">显示最近 ${limit} 条 · 共保留最近 100 条写操作</p>` : `<p class="feed__more">保留最近 100 条写操作</p>`;
  return `<div class="feed">${rows}</div>${more}`;
}

/* ---- 创建表单块（三个方向共用）---- */
function createBlockHtml() {
  const presets = PRESETS.map(p => `
    <button type="button" class="preset" data-preset="${p.id}" data-name="${p.name}">
      <span class="agent-avatar" style="--av:34px;background:${p.bg};color:${p.fg}">${logoSvg(p.id)}</span>
      <span>${p.name}</span>
    </button>`).join("");
  return `
  <div class="create-block" data-create>
    <div class="create-block__row">
      <div class="presets">${presets}
        <button type="button" class="preset preset--custom" data-preset="custom">
          <span class="agent-avatar" style="--av:34px">${icon("upload", 15)}</span>
          <span>自定义</span>
        </button>
      </div>
    </div>
    <div class="create-block__row">
      <label class="field create-block__name">名称
        <input type="text" name="tokenName" placeholder="如：我的 Agent" maxlength="100">
      </label>
      <div class="field">权限
        <div class="seg" data-access>
          <button type="button" data-access="read">只读</button>
          <button type="button" class="is-on" data-access="write">读写</button>
        </div>
      </div>
    </div>
    <div class="create-block__foot">
      <span class="muted-3">身份随令牌保存。Agent 的操作以此身份署名。</span>
      <span style="display:flex;gap:8px">
        <button type="button" class="btn" data-cancel>取消</button>
        <button type="button" class="btn btn--primary" data-submit disabled>创建</button>
      </span>
    </div>
  </div>`;
}

/* 共享的表单行为：预设选择、权限分段、提交演示。 */
function wireCreateBlock(root, { onCancel, onCreated } = {}) {
  const nameInput = root.querySelector('[name="tokenName"]');
  const submit = root.querySelector('[data-submit]');
  const update = () => { submit.disabled = !nameInput.value.trim(); };
  root.querySelectorAll(".preset").forEach(btn => btn.addEventListener("click", () => {
    root.querySelectorAll(".preset").forEach(b => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    if (btn.dataset.name) nameInput.value = btn.dataset.name;
    update();
  }));
  root.querySelectorAll("[data-access] > button").forEach(btn => btn.addEventListener("click", () => {
    root.querySelectorAll("[data-access] > button").forEach(b => b.classList.remove("is-on"));
    btn.classList.add("is-on");
  }));
  nameInput.addEventListener("input", update);
  root.querySelector("[data-cancel]").addEventListener("click", () => onCancel && onCancel());
  submit.addEventListener("click", () => onCreated && onCreated({
    name: nameInput.value.trim(),
    access: root.querySelector("[data-access] .is-on").dataset.access,
  }));
}

/* ---- 主题切换工具条 ---- */
function protoBar({ anchor } = {}) {
  const bar = document.createElement("div");
  bar.className = "proto-bar";
  bar.innerHTML = (anchor ? `<a href="${anchor}">对比</a>` : "") +
    `<button type="button" data-theme="light">${icon("sun", 12)}浅色</button>
     <button type="button" data-theme="dark">${icon("moon", 12)}深色</button>`;
  document.body.appendChild(bar);
  const apply = t => { document.documentElement.dataset.theme = t; };
  const saved = sessionStorage.getItem("proto-theme") || "dark";
  apply(saved);
  bar.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    apply(b.dataset.theme); sessionStorage.setItem("proto-theme", b.dataset.theme);
  }));
}

/* 侧栏骨架：固定选中「Agent 令牌」。返回 dialog 元素。 */
function shellHtml() {
  const item = (label, iconName, sel) =>
    `<button type="button" class="snav__item${sel ? " is-selected" : ""}">${icon(iconName, 15)}<span>${label}</span></button>`;
  const tpl = document.createElement("template");
  tpl.innerHTML = `
  <div class="dialog">
    <nav class="snav">
      <div class="snav__search">${icon("search", 13)}<span>搜索设置</span></div>
      <div class="snav__group">账号</div>
      ${item("账号", "user")}
      ${item("偏好", "settings")}
      ${item("邀请", "invite")}
      <div class="snav__group">功能</div>
      ${item("Agent 令牌", "bot", true)}
    </nav>
    <main class="smain">
      <button type="button" class="icon-btn sclose">${icon("x", 15)}</button>
      <div class="smain__content"></div>
    </main>
  </div>`;
  const el = tpl.content.firstElementChild;
  el.querySelector(".smain__content").id = "content";
  return el;
}

function toast(msg) {
  let el = document.querySelector(".proto-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "proto-toast";
    el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 14px;border-radius:6px;background:var(--elevated);box-shadow:var(--shadow-pop);color:var(--ink);font-size:13px;z-index:20;opacity:0;transition:opacity .15s";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => { el.style.opacity = "1"; });
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, 1800);
}
