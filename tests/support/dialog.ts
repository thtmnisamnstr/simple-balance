/**
 * jsdom ships `<dialog>` without `showModal`, so every component test that opens
 * one needs this. It lives here rather than in each file so a new test that
 * renders a dialog works without discovering the gap first.
 *
 * Loaded for every test; the guard keeps it inert in the Node environment.
 */
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
