/**
 * ui/mapControls.js
 *
 * Gestiona los controles del mapa que requieren lógica JS propia.
 * Los widgets nativos del SDK (zoom, home, compass, locate) van directamente
 * en slot="top-right" del HTML — no necesitan JS aquí.
 *
 * ── RESPONSABILIDAD ÚNICA ────────────────────────────────────────────────
 * Solo controles sobre el mapa con comportamiento propio.
 * No sabe de capas, municipios, catálogo ni paneles laterales.
 *
 * ── PATRÓN ───────────────────────────────────────────────────────────────
 * Referencia: sample oficial Esri views-switch-2d-3d.
 * calcite-button con appearance="outline-fill" kind="neutral" flota
 * Dos instancias del botón (una por vista) se sincronizan vía eventBus.
 */

import * as mapManager from "../core/mapManager.js";
import * as eventBus   from "../utils/eventBus.js";
import { t }           from "../config/i18n/i18nManager.js";

let _btnMap   = null; // botón en arcgis-map (vista 2D activa)
let _btnScene = null; // botón en arcgis-scene (vista 3D activa)

export function initMapControls() {
  _btnMap   = document.getElementById("btn-toggle-vista");
  _btnScene = document.getElementById("btn-toggle-vista-scene");

  if (!_btnMap || !_btnScene) {
    console.warn("[mapControls] Botones de toggle no encontrados.");
    return;
  }

  _btnMap.addEventListener("click",   _handleToggleVista);
  _btnScene.addEventListener("click", _handleToggleVista);

  eventBus.on("vista-cambiada",  ({ modo }) => _actualizarBotones(modo));
  eventBus.on("idioma-cambiado", ()          => _actualizarBotones(mapManager.getVistaActiva()));

  // Estado inicial
  _actualizarBotones(mapManager.getVistaActiva());
}

async function _handleToggleVista() {
  // Deshabilitar ambos durante la transición
  if (_btnMap)   _btnMap.loading   = true;
  if (_btnScene) _btnScene.loading = true;

  try {
    await mapManager.toggleVista();
  } catch (err) {
    console.error("[mapControls] Error al cambiar vista:", err);
  } finally {
    if (_btnMap)   _btnMap.loading   = false;
    if (_btnScene) _btnScene.loading = false;
  }
}

function _actualizarBotones(modo) {
  const textoToggle = modo === "3D" ? t("action.toggle2d") : t("action.toggle3d");
  const iconoToggle = modo === "3D" ? "2d" : "3d";

  [_btnMap, _btnScene].forEach(btn => {
    if (!btn) return;
    btn.iconStart    = iconoToggle;
    btn.label        = textoToggle;  // accesibilidad (aria-label interno de Calcite)
    btn.title        = textoToggle;  // tooltip nativo del navegador
    btn.textContent  = "";           // sin texto visible dentro del botón
  });
}