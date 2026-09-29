// Hands the vendored tasks-vision build to psx.js, which decides whether the
// Holistic / FaceMesh globals the bundle calls get replaced with the GPU
// tracking shim (see the tracker shim section of docs/psx.js).
//
// Deferred classic scripts run in document order: the legacy Mediapipe
// globals load first, then the tasks-vision build, then this, then the app
// bundle. This is the one point where both exist and the bundle has not run
// yet - which is what installing the shim needs. The guard does the stub's
// job locally: a page whose psx.js failed to load runs as upstream.
if (window.PSX && window.PSX.tasksReady) window.PSX.tasksReady(window.Vision);
