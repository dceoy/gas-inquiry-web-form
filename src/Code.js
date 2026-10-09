/* global HtmlService */

/** Serve the placeholder page; inquiry handling is tracked in issue #1. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index").setTitle("Inquiry");
}
