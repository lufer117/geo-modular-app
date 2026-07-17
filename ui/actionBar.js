// ui/actionBar.js
//
// Responsabilidad: gestionar el action bar lateral y sus paneles asociados.
// Controla: apertura/cierre de paneles y toggle 2D/3D.
// NO sabe de capas, municipios, leyenda ni del mapa directamente.

import * as eventBus from "../utils/eventBus.js";
import * as mapManager from "../core/mapManager.js";
import { t } from "../config/i18n/i18nManager.js";

// ─── Referencias DOM ─────────────────────────────────────────────────────────
// Se resuelven una sola vez en initActionBar() y se reutilizan en todos los handlers.
// Evita querySelector repetidos en cada interacción.

let _actionBar       = null; // <calcite-action-bar>
let _panelCapas      = null; // <calcite-panel id="panel-capas">
let _actionCapas     = null; // <calcite-action id="action-capas">
let _actionVista     = null; // <calcite-action id="action-toggle-vista">
let _shellPanelStart = null; // <calcite-shell-panel id="shell-panel-start">

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa el action bar.
 * Llama desde main.js después de initMap().
 * El toggle 2D/3D necesita que el mapa ya exista.
 */
export function initActionBar() {
  _resolverReferencias();
  _registrarListeners();
}

/**
 * Actualiza el icono y tooltip del botón de vista.
 * Llamado por main.js tras restaurar estado post-idioma,
 * donde el toggle ya ocurrió antes de que actionBar existiera.
 * @param {"2D"|"3D"} modo
 */
export function setVistaActiva(modo) {
  if (!_actionVista) return;
  _actualizarBotonVista(modo);
}

// ─── Privadas ─────────────────────────────────────────────────────────────────

function _resolverReferencias() {
  _shellPanelStart = document.getElementById("shell-panel-start");
  _actionBar       = document.getElementById("main-action-bar");
  _panelCapas      = document.getElementById("panel-capas");
  _actionCapas     = document.getElementById("action-capas");
  _actionVista     = document.getElementById("action-toggle-vista");
}

function _registrarListeners() {
  // ── CORRECCIÓN: calcite-action no emite calciteActionClick.
  // El evento correcto es 'click' nativo del DOM, confirmado en la
  // documentación oficial de Calcite:
  // developers.arcgis.com/calcite-design-system/components/action/#accessibility

  _actionCapas.addEventListener("click", () => _togglePanel("panel-capas", _actionCapas));
  _actionVista.addEventListener("click", () => _handleToggleVista());

  // Sincronización desde eventBus: actualiza el botón de vista cuando
  // el toggle ocurre desde cualquier fuente (no solo desde este módulo)
  eventBus.on("vista-cambiada", ({ modo }) => _actualizarBotonVista(modo));
  eventBus.on("idioma-cambiado", () => _actualizarBotonVista(mapManager.getVistaActiva()));
}

/**
 * Abre o cierra un panel por su id.
 * Marca el botón correspondiente como activo/inactivo.
 * Solo un panel puede estar abierto a la vez (comportamiento estándar de action bar).
 */
function _togglePanel(panelId, actionEl) {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  const estaAbierto = !panel.closed;

  // Cerrar todos los paneles y desactivar todos los botones de panel
  _cerrarTodosLosPaneles();

  if (estaAbierto) {
    // Si ya estaba abierto: cerrar el panel Y colapsar el shell-panel.
    // El shell-panel desaparece del layout completamente.
    if (_shellPanelStart) _shellPanelStart.collapsed = true;
    return;
  }

  // Abrir: primero expandir el shell-panel, luego abrir el panel
  if (_shellPanelStart) _shellPanelStart.collapsed = false;
  panel.closed = false;
  actionEl.active = true;
}

function _cerrarTodosLosPaneles() {
  // Selecciona todos los calcite-panel con id.
  // Patrón preparado para cuando haya más paneles (búsqueda, análisis, etc.).
  document.querySelectorAll("calcite-panel[id]").forEach(p => {
    p.closed = true;
  });

  // Desactivar todos los action buttons de panel
  document.querySelectorAll("calcite-action[data-panel]").forEach(a => {
    a.active = false;
  });

  // NO colapsa el shell-panel aquí — lo hace _togglePanel según el caso
  // para distinguir entre "cerrar para abrir otro" vs "cerrar definitivamente"
}

/**
 * Gestiona el toggle 2D/3D.
 * Llama a mapManager y deja que el eventBus notifique el resultado.
 * El icono se actualiza en el listener de "vista-cambiada", no aquí,
 * para que funcione también cuando el toggle viene de otra fuente.
 */
async function _handleToggleVista() {
  // Estado de carga mientras la transición ocurre (puede tardar en 3D)
  if (_actionVista) _actionVista.loading = true;

  try {
    await mapManager.toggleVista();
    // El eventBus emitirá "vista-cambiada" con el nuevo modo.
    // _actualizarBotonVista se ejecutará desde ese listener.
  } catch (err) {
    console.error("[actionBar] Error al cambiar vista:", err);
  } finally {
    if (_actionVista) _actionVista.loading = false;
  }
}

/**
 * Actualiza el icono y tooltip del botón de vista según el modo activo.
 * Se llama tanto desde el listener de eventBus como desde setVistaActiva().
 */
function _actualizarBotonVista(modo) {
  if (!_actionVista) return;

  if (modo === "3D") {
    const texto = t("action.toggle2d");
    _actionVista.icon   = "2d"; // icono de "volver a 2D"
    _actionVista.text   = texto;
    _actionVista.title  = texto;
    _actionVista.label  = texto;
    _actionVista.active = true;
  } else {
    const texto = t("action.toggle3d");
    _actionVista.icon   = "3d"; // icono de "ir a 3D"
    _actionVista.text   = texto;
    _actionVista.title  = texto;
    _actionVista.label  = texto;
    _actionVista.active = false;
  }
}