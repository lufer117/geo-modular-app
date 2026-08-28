/**
 * ui/legendPanel.js
 *
 * Responsabilidad: Gestionar el ciclo de vida completo de la leyenda flotante.
 * Incluye: montaje del Web Component <arcgis-legend>, visibilidad del panel
 * flotante, posicionamiento inicial junto al trigger, drag arrastrable y
 * persistencia de posición en localStorage.
 *
 * NO sabe de capas, municipios ni del mapa directamente.
 * Se comunica con el resto de la app exclusivamente via EventBus.
 */

import { on } from "../utils/eventBus.js";

// ─── Clave de persistencia ────────────────────────────────────────────────────
const LEGEND_POS_KEY = "geo-app-legend-pos";

// ─── Referencias DOM ─────────────────────────────────────────────────────────
// Se resuelven una sola vez en initLegendPanel() y se reutilizan en todos los handlers.
// Evita querySelector repetidos en cada interacción.

let _legendEl      = null; // <arcgis-legend> Web Component — instancia única
let _legendFloat   = null; // <div id="legend-float-container"> — panel flotante
let _legendTrigger = null; // <button id="legend-map-trigger"> — botón bottom-right
let _legendClose   = null; // <calcite-action id="legend-float-close"> — botón X

// ─── Estado interno ───────────────────────────────────────────────────────────
let _legendVisible = false;
let _vistaActual = "map-view"; // trackea qué toggle usar como referencia de posición

// Estado del drag — scope de módulo para que _moverPanel los lea
let _dragging = false;
let _offsetX  = 0;
let _offsetY  = 0;

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa la leyenda flotante completa:
 * monta <arcgis-legend>, resuelve referencias DOM, registra listeners y drag.
 * Llama desde main.js después de initMap().
 *
 * @param {string} initialViewId - ID del Web Component de vista activo al arrancar.
 */
export function initLegendPanel(initialViewId = "map-view") {
  const container = document.getElementById("legend-container");

  if (!container) {
    console.warn("[legendPanel] No se encontró el ancla #legend-container en el DOM.");
    return;
  }

   _vistaActual = initialViewId; // guardar la vista inicial para que el trigger sepa a qué vista referenciarse

  // Crear el Web Component nativo de ArcGIS Maps SDK v5.
  // Es reactivo por diseño: se vincula a una vista mediante 'reference-element'
  // y se actualiza automáticamente cuando cambian las capas visibles.
  _legendEl = document.createElement("arcgis-legend");
  _legendEl.setAttribute("reference-element", initialViewId);


  // Solo mostrar capas con visibilidad activa en el mapa — leyenda limpia.
  _legendEl.setAttribute("hide-layers-not-in-view", "");

  container.appendChild(_legendEl);

  _resolverReferencias();
  _registrarListeners();
  _initDrag();
  _restaurarPosicion();
_posicionarTriggerBajoUltimoControl(); // posición inicial del trigger

  console.info(`[legendPanel] Inicializado y vinculado a #${initialViewId}`);
}

/**
 * Actualiza la referencia del Web Component de leyenda.
 * Permite que la leyenda "salte" entre el mapa 2D y la escena 3D
 * sin desmontar ni remontar el componente.
 *
 * @param {string} elementId - "map-view" | "scene-view"
 */
export function actualizarReferencia(elementId) {
  if (!_legendEl) return;
  _legendEl.setAttribute("reference-element", elementId);
}

// ─── Privadas ─────────────────────────────────────────────────────────────────

function _resolverReferencias() {
  _legendFloat   = document.getElementById("legend-float-container");
  _legendTrigger = document.getElementById("legend-map-trigger");
  _legendClose   = document.getElementById("legend-float-close");
}

function _registrarListeners() {
  // Trigger bottom-right: abre/cierra el panel flotante
  _legendTrigger.addEventListener("click", () => _setLeyendaVisible(!_legendVisible));

  // Botón X dentro del panel flotante: cierra la leyenda
  _legendClose.addEventListener("click", () => _setLeyendaVisible(false));

  // Cambio de vista 2D/3D: redirige la leyenda a la vista activa.
  // La leyenda siempre muestra el contenido de lo que el usuario está viendo.
  on("vista-cambiada", ({ modo }) => {
    const targetId = modo === "3D" ? "scene-view" : "map-view";
    _vistaActual = targetId; 
    actualizarReferencia(targetId);
    _posicionarTriggerBajoUltimoControl(); // reposicionar el trigger para que quede bajo el toggle de vista
  });

  // si el layout cambia (viewport, DPI, más botones apilados encima)
  window.addEventListener("resize", _posicionarTriggerBajoUltimoControl);

  // Hook disponible para extensiones futuras (badge de capas activas, etc.)
  on("municipio-cargado", () => {
    console.debug("[legendPanel] Municipio cambiado: la leyenda se actualizará automáticamente.");
  });
}

/**
 * Muestra u oculta el panel flotante de leyenda.
 * Al abrir por primera vez (sin posición de drag previa), posiciona el panel
 * junto al trigger. En aperturas posteriores respeta la posición que el usuario
 * eligió al arrastrar.
 *
 * Usa visibility+opacity en lugar de display:none para evitar que
 * <arcgis-legend> se desmonte y re-renderice (evita parpadeo).
 *
 * @param {boolean} visible
 */
function _setLeyendaVisible(visible) {
  _legendVisible = visible;

  _legendFloat.classList.toggle("hidden", !visible);
  _legendTrigger.classList.toggle("active", visible);

  // Al abrir: posicionar junto al trigger solo si el usuario no ha arrastrado aún.
  // Si style.left tiene valor, el usuario ya eligió una posición — respetarla.
  if (visible && _legendFloat.style.left === "") {
    _posicionarJuntoAlTrigger();
  }
}

/**
 * Posiciona el trigger de leyenda justo debajo del último control nativo
 * apilado en la columna top-right del SDK, para la vista activa.
 *
 * Por qué NO referenciar directamente el botón toggle:
 * el toggle vive dentro del slot nativo top-right junto a zoom/home/compass/
 * locate — y en 3D el SDK añade además arcgis-navigation-toggle (control de
 * "padding mode"), que se apila DESPUÉS del toggle en el DOM. Referenciar el
 * toggle asume que es el último elemento de la columna, cierto en 2D pero
 * falso en 3D — el trigger terminaba posicionado encima de navigation-toggle.
 * Confirmado por inspección de DOM real: en <arcgis-scene>, el orden de
 * slot="top-right" es zoom → home → compass → locate → toggle → navigation-toggle.
 *
 * Solución: en vez de asumir cuál es el último control, se pregunta al DOM
 * cuál es realmente el último hijo con slot="top-right" de la vista activa.
 * Así el trigger sigue la columna completa sea cual sea su composición real
 * (2D, 3D, o si el SDK añade/quita controles en una futura versión) sin
 * necesidad de mantener una lista de "cuántos controles hay antes del mío".
 */

function _posicionarTriggerBajoUltimoControl() {
  if (!_legendTrigger) return;

  const viewElId = _vistaActual; // "map-view" | "scene-view"
  const viewEl = document.getElementById(viewElId);
  const container = document.getElementById("map-container");

  if (!viewEl || !container) return;

  const ultimoControl = _obtenerUltimoControlTopRight(viewEl);
  if (!ultimoControl) return; // sin controles nativos aún — nada que referenciar

  const controlRect   = ultimoControl.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // Guard clave: si el control aún no tiene layout real (0x0), no es una
  // posición válida — no revelamos el trigger con coordenadas basura.
  if (controlRect.width === 0 && controlRect.height === 0) return;

  const MARGIN = 12; // separación visual respecto al último control
  const top   = controlRect.bottom - containerRect.top + MARGIN;
  const right = containerRect.right - controlRect.right;

  // #map-container es position:fixed → left/top del trigger son relativos a él.
  // Se limpia 'bottom' porque coexistir con 'top' en el mismo eje causa conflicto CSS.
  _legendTrigger.style.top    = `${top}px`;
  _legendTrigger.style.right  = `${right}px`;
  _legendTrigger.style.bottom = "";

  // Solo se revela cuando ya tiene coordenadas confirmadas válidas.
  _legendTrigger.classList.add("legend-trigger--posicionado");
}

/**
 * Devuelve el último hijo light-DOM de la vista con slot="top-right".
 * El SDK apila los controles nativos (zoom, home, compass, locate, toggle,
 * navigation-toggle en 3D...) en el orden en que aparecen como children —
 * el último del array es, por construcción del slot, el que queda más abajo
 * visualmente en la columna. No se asume cuántos controles hay ni cuál es
 * "el nuestro": se pregunta al DOM real de la vista activa.
 *
 * @param {HTMLElement} viewEl - <arcgis-map> o <arcgis-scene> activo
 * @returns {HTMLElement|null}
 */
function _obtenerUltimoControlTopRight(viewEl) {
  const controles = Array.from(viewEl.children).filter(
    (el) => el.getAttribute("slot") === "top-right"
  );
  return controles.length ? controles[controles.length - 1] : null;
}

/**
 * Calcula y aplica la posición inicial del panel flotante junto al trigger.
 * La leyenda aparece a la izquierda del trigger, alineada por su borde inferior.
 *
 * Usa getBoundingClientRect() porque el trigger es un elemento arbitrario
 * en el DOM — CSS no puede leer la posición de otro elemento para usarla
 * como referencia. El contenedor padre (#map-container) tiene position:fixed,
 * así que left/top del flotante son directamente coordenadas de viewport.
 */
function _posicionarJuntoAlTrigger() {
  const triggerRect = _legendTrigger.getBoundingClientRect();
  const floatWidth  = _legendFloat.offsetWidth  || 200; // fallback si aún no renderizó
  const floatHeight = _legendFloat.offsetHeight || 320;

  // Borde derecho de la leyenda alineado con borde izquierdo del trigger (10px margen)
  const left = triggerRect.left - floatWidth - 10;
  // Borde inferior de la leyenda alineado con borde inferior del trigger
  const top  = triggerRect.bottom - floatHeight;

  // Clamp: evitar que el panel salga del viewport por arriba o por la izquierda
  const safeLeft = Math.max(10, left);
  const safeTop  = Math.max(10, top);

  // Limpiar bottom/right para que no entren en conflicto con left/top
  _legendFloat.style.bottom = "";
  _legendFloat.style.right  = "";
  _legendFloat.style.left   = `${safeLeft}px`;
  _legendFloat.style.top    = `${safeTop}px`;
}

// ─── DRAG ─────────────────────────────────────────────────────────────────────

/**
 * Hace el panel flotante arrastrable desde su header (handle).
 *
 * Estrategia de coordenadas:
 * - mousedown captura el offset entre cursor y esquina superior izquierda
 *   del panel en ese instante (offsetLeft/offsetTop relativo al padre).
 * - mousemove aplica la nueva posición directamente como left/top,
 *   limpiando bottom/right para evitar conflicto CSS.
 * - mouseup persiste la posición en localStorage.
 *
 * IMPORTANTE: se usa offsetLeft/offsetTop (relativo al padre position:fixed)
 * y NO getBoundingClientRect() (relativo al viewport) para capturar el offset
 * inicial. Mezclar los dos sistemas causa un salto de posición al iniciar el drag.
 */
function _initDrag() {
  if (!_legendFloat) return;

  // Solo el título actúa como handle — el botón X queda fuera del área de arrastre
  const handle = _legendFloat.querySelector(".legend-drag-handle");
  if (!handle) return;

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // solo botón izquierdo

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

  // Soporte táctil — passive:true para no bloquear el scroll nativo
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
  // Limpiar bottom/right antes de aplicar left/top
  // para evitar que CSS los sobreescriba durante el drag
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

/**
 * Restaura la posición guardada en localStorage al inicializar.
 * Si la posición guardada queda fuera del viewport actual (cambio de resolución),
 * se descarta y se deja que CSS o _posicionarJuntoAlTrigger controlen la posición.
 */
function _restaurarPosicion() {
  const raw = localStorage.getItem(LEGEND_POS_KEY);
  if (!raw) return;

  try {
    const { left, top } = JSON.parse(raw);
    const floatWidth  = 200;
    const floatHeight = 100;
    const maxLeft = window.innerWidth  - floatWidth  - 10;
    const maxTop  = window.innerHeight - floatHeight - 10;

    if (left < 0 || top < 0 || left > maxLeft || top > maxTop) {
      localStorage.removeItem(LEGEND_POS_KEY);
      return; // posición inválida — CSS/trigger controlarán la posición inicial
    }

    _legendFloat.style.bottom = "";
    _legendFloat.style.right  = "";
    _legendFloat.style.left   = `${left}px`;
    _legendFloat.style.top    = `${top}px`;

  } catch {
    localStorage.removeItem(LEGEND_POS_KEY);
  }
}