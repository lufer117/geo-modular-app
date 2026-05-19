/**
 * ui/basemapSelector.js
 *
 * Selector de mapa base.
 *
 * ── BASEMAPS DISPONIBLES ─────────────────────────────────────────────────
 * Sin API Key activa → solo "osm" funciona sin restricciones.
 * Los basemaps de Esri (arcgis/*) requieren API Key o cuenta ArcGIS Online.
 * Se incluyen preparados para cuando el proyecto tenga clave configurada.
 *
 * ── EXTENSIÓN ────────────────────────────────────────────────────────────
 * Añadir un basemap nuevo = añadir una entrada en BASEMAPS. Sin más cambios.
 *
 * ── COMUNICACIÓN ─────────────────────────────────────────────────────────
 * Al cambiar basemap emite "basemap-cambiado" en el eventBus.
 * Otros módulos pueden reaccionar si necesitan adaptar su visualización.
 */

import * as mapManager from "../core/mapManager.js";
import { emit }        from "../utils/eventBus.js";

// Catálogo de basemaps disponibles en la app
// id: valor que ArcGIS Map acepta directamente en map.basemap
const BASEMAPS = [
  { id: "osm",                label: "🗺  OpenStreetMap",     available: true  },
  { id: "arcgis/topographic", label: "⛰  Topográfico Esri",  available: false }, // requiere API Key
  { id: "arcgis/imagery",     label: "🛰  Satélite",          available: false },
  { id: "arcgis/navigation",  label: "🚗  Callejero Esri",    available: false },
  { id: "arcgis/dark-gray",   label: "🌑  Gris oscuro",       available: false }
];

const DEFAULT_BASEMAP = "osm";

/**
 * Renderiza el selector de basemap en el contenedor indicado.
 * @param {HTMLElement|string} container
 */
export function renderBasemapSelector(container) {
  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    console.error("[basemapSelector] Contenedor no encontrado:", container);
    return;
  }

  const select = document.createElement("calcite-select");
  select.id = "basemap-select";
  select.setAttribute("label", "Mapa base");

  BASEMAPS.forEach(({ id, label, available }) => {
    const opt = document.createElement("calcite-option");
    opt.value       = id;
    opt.textContent = available ? label : `${label} (requiere API Key)`;
    opt.disabled    = !available;
    if (id === DEFAULT_BASEMAP) opt.setAttribute("selected", "");
    select.appendChild(opt);
  });

  select.addEventListener("calciteSelectChange", e => {
    const basemapId = e.target.value;
    mapManager.setBasemap(basemapId);
    emit("basemap-cambiado", { basemapId });
    console.info(`[basemapSelector] Basemap → ${basemapId}`);
  });

  el.appendChild(select);
}