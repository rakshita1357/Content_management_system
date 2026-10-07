// Where the ad server (the Node backend) lives.
// Empty string = the same server that served this page (normal browser use: open http://<server>:8080/tv/).
// A packaged TV app (webOS, Android TV) sets the full address instead, for example:
//   window.TV_CONFIG = { apiBase: 'http://192.168.1.20:8080' };
window.TV_CONFIG = { apiBase: '' };
