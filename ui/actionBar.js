// ui/actionBar.js
// Responsabilidad: gestionar el action bar lateral y sus paneles asociados.
// Controla: apertura/cierre de paneles, leyenda flotante, toggle 2D/3D.
// NO sabe de capas, municipios ni del mapa directamente.

import * as eventBus from "../utils/eventBus.js";
import * as mapManager from "../core/mapManager.js";
import { t } from "../config/i18n/i18nManager.js";


// ─── Clave de persistencia ────────────────────────────────────────────────────
const LEGEND_POS_KEY = "geo-app-legend-pos";

// ─── Referencias DOM ─────────────────────────────────────────────────────────
// Se resuelven una sola vez en init() y se reutilizan en todos los handlers.
// Evita querySelector repetidos en cada interacción.

let _actionBar       = null;  // <calcite-action-bar>
let _panelCapas      = null;  // <calcite-panel id="panel-capas">
let _legendFloat     = null;  // <div id="legend-float-container">
let _legendTrigger   = null;  // <button id="legend-map-trigger">
let _legendClose     = null;  // <calcite-action id="legend-float-close">
let _actionCapas     = null;  // <calcite-action id="action-capas">
let _actionLeyenda   = null;  // <calcite-action id="action-leyenda">
let _actionVista     = null;  // <calcite-action id="action-toggle-vista">
let _shellPanelStart = null; // <calcite-shell-panel id="shell-panel-start"> (contenedor de action bar y paneles)

// ─── Estado interno ───────────────────────────────────────────────────────────
let _legendVisible = false;

// Estado del drag — scope de módulo para que _moverPanel los lea
let _dragging = false;
let _offsetX  = 0;
let _offsetY  = 0;

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa el action bar.
 * Llama desde main.js después de initMap().
 * El toggle 2D/3D necesita que el mapa ya exista.
 */
export function initActionBar() {
  _resolverReferencias();
  _registrarListeners();
  _initDrag();          // drag registrado una sola vez tras resolver referencias
  _restaurarPosicion(); // aplica posición guardada si existe
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
  _actionBar     = document.getElementById("main-action-bar");
  _panelCapas    = document.getElementById("panel-capas");
  _legendFloat   = document.getElementById("legend-float-container");
  _legendTrigger = document.getElementById("legend-map-trigger");
  _legendClose   = document.getElementById("legend-float-close");
  _actionCapas   = document.getElementById("action-capas");
  _actionLeyenda = document.getElementById("action-leyenda");
  _actionVista   = document.getElementById("action-toggle-vista");
}

function _registrarListeners() {
  // ── CORRECCIÓN: calcite-action no emite calciteActionClick.
  // El evento correcto es 'click' nativo del DOM, confirmado en la
  // documentación oficial de Calcite: 
  // developers.arcgis.com/calcite-design-system/components/action/#accessibility
  
  _actionCapas.addEventListener("click",   () => _togglePanel("panel-capas", _actionCapas));
  _actionLeyenda.addEventListener("click", () => _setLeyendaVisible(!_legendVisible));
  _actionVista.addEventListener("click",   () => _handleToggleVista());
  // El botón X nativo del calcite-panel emite calcitePanelClose.
  // Cuando el usuario cierra el panel con la X, colapsamos el shell-panel también.
  _panelCapas.addEventListener("calcitePanelClose", () => {
    if (_shellPanelStart) _shellPanelStart.collapsed = true;
    if (_actionCapas)    _actionCapas.active = false;
  });

  // Estos dos no cambian
  _legendClose.addEventListener("click",   () => _setLeyendaVisible(false));
  _legendTrigger.addEventListener("click", () => _setLeyendaVisible(!_legendVisible));

  // Sincronización desde eventBus — no cambia
  eventBus.on("vista-cambiada", ({ modo }) => _actualizarBotonVista(modo));
  eventBus.on("idioma-cambiado", () => _actualizarBotonVista(mapManager.getVistaActiva()));
}



// ─── DRAG ─────────────────────────────────────────────────────────────────────
/**
 * Hace la leyenda flotante arrastrable desde su header.
 *
 * Estrategia:
 * - mousedown/touchstart en el header captura el offset entre cursor y esquina
 *   superior izquierda del panel en ese instante.
 * - mousemove/touchmove calcula la nueva posición y la aplica directamente
 *   como left/top (removiendo bottom/right para no generar conflicto CSS).
 * - mouseup/touchend persiste la posición en localStorage.
 *
 * Coordenadas en píxeles absolutos respecto al viewport.
 * Al restaurar se aplica clamp: si la posición guardada deja el panel
 * fuera de pantalla (cambio de resolución), se reajusta al interior visible.
 */
// ─── DRAG ─────────────────────────────────────────────────────────────────────

function _initDrag() {
  if (!_legendFloat) return;

  // Solo el título es el handle — el botón de cierre queda fuera
  const handle = _legendFloat.querySelector(".legend-drag-handle");
  if (!handle) return;

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;

    // Leer left/top actuales del panel como números.
    // parseFloat("58px") → 58. Si el estilo inline está vacío,
    // leer offsetLeft/offsetTop que ya son relativos al padre.
    const currentLeft = parseFloat(_legendFloat.style.left) || _legendFloat.offsetLeft;
    const currentTop  = parseFloat(_legendFloat.style.top)  || _legendFloat.offsetTop;

    _dragging = true;
    _offsetX  = e.clientX - currentLeft;
    _offsetY  = e.clientY - currentTop;
  });

  document.addEventListener("mousemove", (e) => {
    if (!_dragging) return;
    _moverPanel(e.clientX, e.clientY);
  });

  document.addEventListener("mouseup", () => {
    if (!_dragging) return;
    _dragging = false;
    _guardarPosicion();
  });

  handle.addEventListener("touchstart", (e) => {
  const touch = e.touches[0];
  const currentLeft = parseFloat(_legendFloat.style.left) || _legendFloat.offsetLeft;
  const currentTop  = parseFloat(_legendFloat.style.top)  || _legendFloat.offsetTop;
  _dragging = true;
  _offsetX  = touch.clientX - currentLeft;
  _offsetY  = touch.clientY - currentTop;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!_dragging) return;
    const touch = e.touches[0];
    _moverPanel(touch.clientX, touch.clientY);
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!_dragging) return;
    _dragging = false;
    _guardarPosicion();
  });
}

function _moverPanel(clientX, clientY) {
  _legendFloat.style.bottom = "";
  _legendFloat.style.right  = "";
  _legendFloat.style.left   = `${clientX - _offsetX}px`;
  _legendFloat.style.top    = `${clientY - _offsetY}px`;
}

function _guardarPosicion() {
  const rect = _legendFloat.getBoundingClientRect();
  localStorage.setItem(LEGEND_POS_KEY, JSON.stringify({
    left: rect.left,
    top:  rect.top
  }));
}

function _restaurarPosicion() {
  const raw = localStorage.getItem(LEGEND_POS_KEY);
  if (!raw) return; // sin posición guardada → CSS controla (bottom:60px left:58px)

  try {
    const { left, top } = JSON.parse(raw);
    const w    = 200;
    const maxL = window.innerWidth  - w   - 10;
    const maxT = window.innerHeight - 100 - 10;

    // Solo aplicar si la posición es válida (no fuera de pantalla)
    if (left < 0 || top < 0 || left > maxL || top > maxT) {
      localStorage.removeItem(LEGEND_POS_KEY);
      return; // posición inválida → CSS controla
    }

    _legendFloat.style.bottom = "";
    _legendFloat.style.right  = "";
    _legendFloat.style.left   = `${left}px`;
    _legendFloat.style.top    = `${top}px`;

  } catch {
    localStorage.removeItem(LEGEND_POS_KEY);
  }
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

  // Si el panel ya estaba abierto, el click lo cierra (toggle)
  if (estaAbierto) {
    // Si ya estaba abierto: cerrar el panel Y colapsar el shell-panel
    // El shell-panel desaparece del layout completamente
    if (_shellPanelStart) _shellPanelStart.collapsed = true;
    return;
  }

  // Abrir: primero expandir el shell-panel, luego abrir el panel
  if (_shellPanelStart) _shellPanelStart.collapsed = false;
  panel.closed = false;
  actionEl.active = true;
}

function _cerrarTodosLosPaneles() {
  // Selecciona todos los calcite-panel que tengan data-panel asociado.
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
 * Muestra u oculta la leyenda flotante.
 * Sincroniza el estado del botón en el action bar y el trigger en el mapa.
 */
function _setLeyendaVisible(visible) {
  _legendVisible = visible;

  _legendFloat.classList.toggle("hidden", !visible);
  _legendTrigger.classList.toggle("legend-trigger--active", visible);

  // Marcar el botón de leyenda en el action bar como activo/inactivo
  if (_actionLeyenda) _actionLeyenda.active = visible;
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
    _actionVista.icon  = "2d";       // icono de "volver a 2D"
    _actionVista.text  = texto;
    _actionVista.title = texto;
    _actionVista.label = texto;
    _actionVista.active = true;
  } else {
    const texto = t("action.toggle3d");
    _actionVista.icon  = "3d";       // icono de "ir a 3D"
    _actionVista.text  = texto;
    _actionVista.title = texto;
    _actionVista.label = texto;
    _actionVista.active = false;
  }
}
 