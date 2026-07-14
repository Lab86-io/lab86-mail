'use client';

// Lazy entry for the tool-ui GeoMap: Leaflet's core stylesheet (tile/pane
// positioning) must ride along with the engine, and importing it here keeps it
// out of the shell bundle until a map actually renders.
import 'leaflet/dist/leaflet.css';

export { GeoMap } from '@/components/tool-ui/geo-map';
