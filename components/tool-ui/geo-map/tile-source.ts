// Browser requests retain their normal Referer and HTTP cache behavior. Only
// visible Leaflet viewports request tiles; there is no prefetch or offline cache.
export const geoMapTileSource = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxNativeZoom: 19,
  maxZoom: 22,
};
