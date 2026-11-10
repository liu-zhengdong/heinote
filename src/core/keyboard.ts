/** A key the input method owns: the Enter that picks a Chinese or Japanese
 *  candidate, the Escape that cancels one, the Space that cycles them. Every
 *  handler that acts on Enter, Escape, Backspace, Tab, Space or an arrow asks
 *  this first. `isComposing` alone is not enough: Safari ends the composition
 *  before the keydown of the Enter that ended it, and only keyCode 229 on
 *  that keydown still says so. */
export function imeComposing(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229;
}
