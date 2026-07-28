/**
 * ui/toolPanel.js
 *
 * Responsabilidad: ciclo de vida completo del panel de herramientas.
 * Construye botones y widgets DINÁMICAMENTE a partir de
 * DEPLOYMENT.herramientas — ningún HTML de herramientas vive en index.html
 * (excepto el trigger fijo #tools-expand / #tools-action-bar, que es
 * infraestructura, no contenido configurable).
 *
 * ── Modelo de datos: herramienta vs widget ──────────────────────────────
 * Una "herramienta" (id) es un concepto de UI = 1 botón.
 * Un widget es el Custom Element real del SDK que la implementa.
 * Para distancia/área, el SDK expone clases DISTINTAS para 2D y 3D
 * (no intercambiables vía reference-element, a diferencia de sketch) —
 * por eso cada herramienta puede declarar `componentes: {"2D":, "3D":}`
 * en vez de un único `componente`. El botón sigue siendo uno solo;
 * toolPanel.js decide en runtime qué widget mostrar según la vista activa.
 * Esto reemplaza el modelo anterior (una entrada de catálogo por
 * combinación herramienta+vista), que producía botones duplicados.
 *
 * Patrón: mismo principio que layerFactory._TIPO_MAP — el nombre del
 * Custom Element viene directo del catálogo, sin mapa de traducción manual.
 *
 * ── Panel flotante por herramienta ───────────────────────────────────────
 * Cada widget con UI propia se monta dentro de un wrapper propio
 * (.tool-widget-float), mismo patrón ya validado en legendPanel.js:
 * header con drag handle + botón cerrar, body con padding real.
 * El Custom Element del SDK nunca se postea "a piel" contra el viewport —
 * así el padding/border no dependen del shadow DOM del componente.
 *
 * Patrón de arrastre: un contenedor propio maneja el drag, el widget del
 * SDK vive adentro sin saber que está siendo arrastrado — mismo enfoque
 * recomendado por Esri Community para lograr paneles arrastrables (el SDK
 * no expone "draggable" nativo en ningún widget/componente).
 *
 * ── Caso especial: arcgis-sketch ─────────────────────────────────────────
 * Sketch trae por defecto `toolbarKind:"floating"` — su propio chrome
 * flotante (sombra, bordes redondeados, tamaño dinámico), pensado para
 * vivir solo sobre el mapa. Como ya lo envolvemos en nuestro propio panel
 * flotante, tener los dos sistemas de chrome activos a la vez producía
 * tamaños impredecibles (sesión 27.07.26). Se fuerza `toolbarKind:"docked"`
 * para que Sketch delegue el chrome flotante a nuestro wrapper.
 *
 * En modo docked, Sketch expande UN eje contra su ancestro según su
 * propiedad `layout` (fija desde deployment.js — no cambia en runtime):
 * "horizontal" → llena el ancho del contenedor; "vertical" → llena el alto.
 * Ese eje se dimensiona en JS (_dimensionarPanelSketch) contando cuántos
 * botones tendrá el toolbar según sketchOpciones — así el overflow "..."
 * del componente (que se dispara automáticamente cuando falta espacio,
 * comportamiento documentado, no un bug) nunca se activa por defecto de
 * cálculo. El eje libre queda en fit-content vía CSS.
 *
 * Posición inicial: alineada con el top de la columna nativa de controles
 * (zoom/home/compass/locate/toggle) y a su izquierda — calculada en runtime
 * porque esa columna vive en shadow DOM del SDK (decisión 24.07.26, mismo
 * guard de rect 0x0), con clamp contra el borde izquierdo del viewport.
 * Aperturas posteriores respetan el drag del usuario.
 */

import { on } from "../utils/eventBus.js";
import { t } from "../config/i18n/i18nManager.js";
import * as mapManager from "../core/mapManager.js";

// ─── Estado del módulo ──────────────────────────────────────────────────────
let _herramientas      = [];        // config activa (DEPLOYMENT.herramientas)
let _botones           = new Map(); // id → <calcite-action>
let _tools              = new Map(); // id → { wrapper, body, elementos: {"2D":el,"3D":el|misma ref}, posicionado }
let _sketchLayer       = null;      // GraphicsLayer única, backing de arcgis-sketch
let _vistaActual       = "2D";
let _herramientaActiva = null;      // id de la herramienta con panel visible, o null

// Acciones que no instancian widget — resueltas por función directa.
// Registro centralizado, mismo patrón que _TIPO_MAP en layerFactory.js.
const ACCIONES_SIN_WIDGET = {
  limpiar: () => _clearAll()
};

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Inicializa el panel de herramientas a partir del catálogo de deployment.
 * Async porque crea la GraphicsLayer de sketch via $arcgis.import().
 *
 * @param {Array} herramientasConfig - DEPLOYMENT.herramientas
 */
export async function initToolPanel(herramientasConfig = []) {
  // Ya NO se filtra por `habilitada` aquí: las herramientas con
  // habilitada:false deben seguir renderizando su icono como "futura
  // opción" (placeholder deshabilitado), no desaparecer del panel.
  // El filtro por habilitada se aplica punto a punto en _construirActionBar
  // y en _crearSketchLayerSiHaceFalta (solo se instancia lo habilitado).
  _herramientas = herramientasConfig;
  _vistaActual  = mapManager.getVistaActiva();

  const actionBar = document.getElementById("tools-action-bar");
  if (!actionBar) {
    console.warn("[toolPanel] #tools-action-bar no encontrado en el DOM.");
    return;
  }

  if (_herramientas.length === 0) {
    document.getElementById("tools-expand")?.setAttribute("hidden", "");
    console.info("[toolPanel] Sin herramientas habilitadas en deployment — panel oculto.");
    return;
  }

  await _crearSketchLayerSiHaceFalta();
  _construirActionBar(actionBar);
  _registrarListenersGlobales();

  console.info(`[toolPanel] Inicializado con ${_herramientas.length} herramienta(s).`);
}

// ─── Construcción dinámica ────────────────────────────────────────────────────

function _construirActionBar(actionBar) {
  const group = document.createElement("calcite-action-group");

  _herramientas.forEach(h => {
    const btn = document.createElement("calcite-action");
    btn.id = `tool-${h.id}`;
    btn.icon = h.icono;

    if (!h.habilitada) {
      // Placeholder "futura opción": icono visible en el panel, sin
      // acción — cumple 3DECISIONS.md 27.07.26 ("documentado en UI pero
      // sin widget instanciado nunca"). Sin listener de click, sin
      // llamada a _crearPanelHerramienta: nada se instancia para una
      // herramienta deshabilitada, aunque el botón sea visible.
      const textoFuturo = `${t(`tools.${h.id}`)} (${t("tools.proximamente")})`;
      btn.disabled = true;
      btn.text = textoFuturo;
      btn.setAttribute("title", textoFuturo);
      btn.setAttribute("label", textoFuturo);

      _botones.set(h.id, btn);
      group.appendChild(btn);
      return; // siguiente herramienta — no crea panel ni entrada en _tools
    }

    const texto = t(`tools.${h.id}`);
    btn.text = texto;
    btn.setAttribute("title", texto);
    btn.setAttribute("label", texto);
    btn.addEventListener("click", () => _handleClick(h));

    _botones.set(h.id, btn);
    group.appendChild(btn);

    // Acciones puras (ej. "limpiar") no tienen componente ni panel.
    if (h.componente || h.componentes) {
      _crearPanelHerramienta(h);
    }
  });

  actionBar.appendChild(group);
}

/**
 * Crea el wrapper flotante de la herramienta (header + body) y, dentro,
 * el/los Custom Element(s) del SDK que la implementan.
 *
 * - `h.componentes` (ej. distancia, área): dos elementos reales, uno por
 *   vista, ambos montados en el DOM pero solo uno VISIBLE según
 *   `_vistaActual` — las clases 2D/3D del SDK no son intercambiables.
 * - `h.componente` (ej. sketch): una única instancia, reference-element
 *   conmutado en "vista-cambiada" — sí es intercambiable.
 *
 * `h.sketchOpciones` (opcional, solo aplica a arcgis-sketch): permite que
 * cada deployment.js configure qué herramientas de creación expone sketch
 * (availableCreateTools), su orientación (layout) y cualquier otra
 * propiedad del componente, sin tocar este módulo — la configuración vive
 * en el catálogo, no en el código.
 *
 * El tipo real de componente (no el `id` editorial de la herramienta)
 * decide si aplica el caso especial de sketch — mismo principio que
 * layerFactory._TIPO_MAP: el código reacciona al tipo, no al nombre que
 * el catálogo le puso.
 */
function _crearPanelHerramienta(h) {
  const portal = document.getElementById("tools-widgets-portal");
  if (!portal) {
    console.warn("[toolPanel] #tools-widgets-portal no encontrado en el DOM.");
    return;
  }

  const { wrapper, body } = _crearWrapperFlotante(h);
  portal.appendChild(wrapper);

  const comp2D = h.componentes?.["2D"] ?? h.componente;
  const comp3D = h.componentes?.["3D"] ?? h.componente;
  const compartido = comp2D === comp3D; // true → sketch (misma instancia, ref conmutada)
  const esSketch = comp2D === "arcgis-sketch";

  const elementos = {};

  if (compartido) {
    const el = document.createElement(comp2D);
    el.id = `widget-${h.id}`;
    el.setAttribute("reference-element", _vistaActual === "3D" ? "scene-view" : "map-view");

    if (esSketch) {
      el.layer = _sketchLayer;
      el.toolbarKind = "docked"; // evita doble chrome flotante — ver JSDoc arriba

      // Configuración editorial opcional por cliente — ver JSDoc arriba.
      if (h.sketchOpciones) Object.assign(el, h.sketchOpciones);

      // Marca el wrapper para que el CSS aplique min/max de seguridad
      // según el eje que Sketch va a llenar (ver styles.css).
      wrapper.dataset.widgetType   = "sketch";
      wrapper.dataset.sketchLayout = h.sketchOpciones?.layout ?? "horizontal";

      // El ancho/alto exacto NO se fija en CSS: se calcula a partir de
      // cuántos botones va a tener el toolbar según la config real del
      // cliente — así el overflow "..." (que Sketch dispara automáticamente
      // cuando falta espacio) nunca se activa por un valor adivinado.
      _dimensionarPanelSketch(wrapper, h.sketchOpciones);
    }

    body.appendChild(el);
    elementos["2D"] = el;
    elementos["3D"] = el;
  } else {
    const el2D = document.createElement(comp2D);
    el2D.id = `widget-${h.id}-2d`;
    el2D.setAttribute("reference-element", "map-view");
    body.appendChild(el2D);
    elementos["2D"] = el2D;

    const el3D = document.createElement(comp3D);
    el3D.id = `widget-${h.id}-3d`;
    el3D.setAttribute("reference-element", "scene-view");
    body.appendChild(el3D);
    elementos["3D"] = el3D;
  }

  // Ambos widgets (2D y 3D) quedan montados en el DOM desde el inicio
  // (evita recrear el Custom Element en cada cambio de vista), pero solo
  // uno debe ser visible/interactivo — sin esto, distancia/área mostraban
  // los dos placeholders superpuestos ("clic en el mapa" + "clic en la escena").
  _mostrarSoloVistaActiva(elementos);

  _tools.set(h.id, { wrapper, body, elementos, posicionado: false });
}

/**
 * Calcula el ancho (layout horizontal) o alto (layout vertical) necesario
 * para que el toolbar de arcgis-sketch en modo docked muestre todos sus
 * botones sin agrupar ninguno en el menú "...".
 *
 * Cuenta: herramientas de creación configuradas (`availableCreateTools`,
 * default del SDK = 5) + botones fijos del toolbar (selección, undo, redo,
 * settings = 4 — presentes salvo que se desactiven explícitamente vía
 * hideUndoRedoMenu / hideSettingsMenu en sketchOpciones).
 *
 * ANCHO_BOTON aproxima el espaciado real de Calcite Action Bar (~40px por
 * acción). MARGEN cubre el padding del wrapper + borde del toolbar —
 * evita quedar justo al límite donde el overflow se dispararía igual.
 */
function _dimensionarPanelSketch(wrapper, opciones = {}) {
  const ANCHO_BOTON = 40;
  const MARGEN      = 32;

  const createTools = opciones.availableCreateTools?.length ?? 5; // default SDK
  let fijos = 1; // selección (no desactivable vía config hoy)
  if (opciones.hideUndoRedoMenu !== true) fijos += 2; // undo + redo
  if (opciones.hideSettingsMenu !== true) fijos += 1; // settings

  const totalBotones = createTools + fijos;
  const medida       = totalBotones * ANCHO_BOTON + MARGEN;

  const layout = opciones.layout ?? "horizontal";
  if (layout === "vertical") {
    wrapper.style.height = `${medida}px`;
  } else {
    wrapper.style.width = `${medida}px`;
  }
}

/**
 * Oculta el widget de la vista que NO está activa cuando una herramienta
 * tiene dos instancias reales (distancia/área). Para sketch, `elementos["2D"]`
 * y `elementos["3D"]` apuntan al mismo elemento — no hay nada que ocultar,
 * la conmutación se hace vía reference-element en "vista-cambiada".
 */
function _mostrarSoloVistaActiva(elementos) {
  if (elementos["2D"] === elementos["3D"]) return; // sketch: instancia compartida
  elementos["2D"].hidden = _vistaActual !== "2D";
  elementos["3D"].hidden = _vistaActual !== "3D";
}

/**
 * Wrapper flotante: header (título + drag handle + cierre) + body con
 * padding real. Mismo patrón que #legend-float-container en index.html —
 * un solo sistema de "panel flotante" en toda la app, no uno nuevo por
 * feature.
 */
function _crearWrapperFlotante(h) {
  const wrapper = document.createElement("div");
  wrapper.id = `tool-panel-${h.id}`;
  wrapper.className = "tool-widget-float";
  wrapper.dataset.toolId = h.id; // hook para futura persistencia por herramienta
  wrapper.hidden = true;

  const header = document.createElement("div");
  header.className = "tool-widget-header";

  const titulo = document.createElement("span");
  titulo.className = "tool-widget-title tool-widget-drag-handle";
  titulo.textContent = t(`tools.${h.id}`);

  const cerrar = document.createElement("calcite-action");
  cerrar.icon = "x";
  cerrar.scale = "s";
  cerrar.setAttribute("appearance", "transparent");
  cerrar.addEventListener("click", () => _toggleHerramienta(h.id));

  header.append(titulo, cerrar);

  const body = document.createElement("div");
  body.className = "tool-widget-body";

  wrapper.append(header, body);
  _habilitarDrag(wrapper, titulo);

  return { wrapper, body };
}

/**
 * GraphicsLayer única que respalda arcgis-sketch — se crea solo si "dibujo"
 * está habilitado en el deployment activo. Se añade UNA sola vez al Map
 * compartido, mismo principio que la máscara municipal en mapManager.
 */
async function _crearSketchLayerSiHaceFalta() {
  const necesitaSketch = _herramientas.some(h => h.habilitada && h.componente === "arcgis-sketch");
  if (!necesitaSketch) return;

  const [GraphicsLayer] = await Promise.all([
    $arcgis.import("esri/layers/GraphicsLayer")
  ]);

  _sketchLayer = new GraphicsLayer({
    id:       "sketch-layer",
    title:    "Dibujo",
    listMode: "hide"
  });

  const map = mapManager.getMap();
  if (!map) {
    console.error("[toolPanel] Map no disponible — ¿se llamó antes de mapManager.initMap()?");
    return;
  }
  map.layers.add(_sketchLayer);
}

// ─── Interacción ──────────────────────────────────────────────────────────────

function _handleClick(h) {
  if (!h.componente && !h.componentes) {
    ACCIONES_SIN_WIDGET[h.id]?.();
    return;
  }
  _toggleHerramienta(h.id);
}

function _toggleHerramienta(id) {
  const yaActiva = _herramientaActiva === id;
  _desactivarTodasLasHerramientas();

  if (yaActiva) {
    _herramientaActiva = null;
    return;
  }

  const tool = _tools.get(id);
  if (!tool) return;

  // Por si la vista cambió entre la creación del panel y esta apertura
  // (ej. usuario alternó 2D/3D sin haber abierto la herramienta aún).
  _mostrarSoloVistaActiva(tool.elementos);

  _herramientaActiva = id;
  tool.wrapper.hidden = false;
  _botones.get(id).active = true;

  if (!tool.posicionado) {
    _posicionarWrapperInicial(tool.wrapper);
    tool.posicionado = true;
  }

  const widgetActivo = tool.elementos[_vistaActual];
  // arcgis-sketch no requiere start() — expone sus propios controles de creación.
  // Los widgets de medición sí: API real del SDK es solo start()/clear(),
  // no existe stop().
  if (typeof widgetActivo.start === "function") widgetActivo.start();
}

function _desactivarTodasLasHerramientas() {
  _tools.forEach((tool, id) => {
    Object.values(tool.elementos).forEach(el => {
      if (typeof el.clear === "function") el.clear();
    });
    tool.wrapper.hidden = true;
    const btn = _botones.get(id);
    if (btn) btn.active = false;
  });
}

/**
 * Limpia todo lo dibujado — mediciones activas + gráficos de sketch —
 * sin importar cuál esté activa en ese momento.
 */
function _clearAll() {
  _desactivarTodasLasHerramientas();
  _sketchLayer?.removeAll();
  _herramientaActiva = null;
}

// ─── Listeners globales ─────────────────────────────────────────────────────────

function _registrarListenersGlobales() {
  on("vista-cambiada", ({ modo }) => {
    _vistaActual = modo;

    // Cambiar de vista con una medición en curso es ambiguo (2D y 3D son
    // widgets distintos, no hay "continuar" entre ellos) — se cierra el
    // panel activo en vez de intentar migrar el estado. El usuario reabre
    // la herramienta si la necesita en la nueva vista. Mismo criterio que
    // ya aplicabas: _clearAll() en cruces de vista evita interacción fantasma.
    _desactivarTodasLasHerramientas();
    _herramientaActiva = null;

    // Cualquier herramienta con instancia COMPARTIDA (hoy solo sketch,
    // pero el criterio es estructural, no un id fijo) conmuta su
    // reference-element para seguir apuntando a la vista activa.
    // Detección por estructura (elementos["2D"] === elementos["3D"]),
    // no por id editorial — mismo criterio ya usado en _mostrarSoloVistaActiva.
    // Un deployment.js puede llamar a esta herramienta "anotaciones" en vez
    // de "dibujo"; el id es configuración y no debe filtrarse a la lógica.
    _tools.forEach(tool => {
      if (tool.elementos["2D"] === tool.elementos["3D"]) {
        tool.elementos["2D"].setAttribute(
          "reference-element",
          modo === "3D" ? "scene-view" : "map-view"
        );
      }
    });
  });

  // Re-traducir botones y títulos de panel al cambiar idioma — se crearon
  // dinámicamente, así que no pasaron por el escaneo inicial data-i18n.
  on("idioma-cambiado", () => {
    _herramientas.forEach(h => {
      const btn = _botones.get(h.id);
      if (btn) {
        const texto = h.habilitada
          ? t(`tools.${h.id}`)
          : `${t(`tools.${h.id}`)} (${t("tools.proximamente")})`;
        btn.text = texto;
        btn.setAttribute("title", texto);
        btn.setAttribute("label", texto);
      }
      const tool = _tools.get(h.id);
      if (tool) {
        tool.wrapper.querySelector(".tool-widget-title").textContent = t(`tools.${h.id}`);
      }
    });
  });
}

// ─── Posicionamiento inicial ────────────────────────────────────────────────

/**
 * Posiciona el wrapper la PRIMERA vez que se abre, alineado con la columna
 * nativa de controles (zoom/home/compass/locate/toggle): mismo `top`,
 * `right` calculado para quedar justo a su izquierda.
 *
 * Por qué en runtime y no un valor fijo en CSS: esa columna vive en
 * slot="top-right" de arcgis-map/arcgis-scene, shadow DOM del SDK — su
 * ancho y posición no son medibles de forma fiable con un valor estático,
 * y pueden variar entre versiones del SDK o si un cliente añade/quita
 * controles nativos. Mismo patrón ya usado en el trigger de leyenda
 * (decisión 24.07.26): medir, descartar rect 0x0, revelar solo si es válido.
 *
 * Clamp de borde izquierdo: como el wrapper mide su contenido real
 * (fit-content / calculado en _dimensionarPanelSketch) en vez de un ancho
 * fijo global, su tamaño final varía según la herramienta — un cálculo que
 * solo mira `right` puede empujar el wrapper fuera del viewport por la
 * izquierda en ventanas angostas. Se mide el ancho real del wrapper
 * (offsetWidth — disponible aunque esté oculto vía `hidden`, a diferencia
 * de `display:none`) y se garantiza un margen mínimo contra el borde.
 *
 * Aperturas posteriores NO llaman a esta función — la posición pasa a ser
 * responsabilidad del usuario vía drag (mismo criterio que legendPanel.js).
 */
function _posicionarWrapperInicial(wrapper) {
  const vistaEl = _vistaActual === "3D"
    ? document.getElementById("scene-view")
    : document.getElementById("map-view");

  const columnaNativa = vistaEl?.querySelector('[slot="top-right"]');
  const rect = columnaNativa?.getBoundingClientRect();

  if (!rect || (rect.width === 0 && rect.height === 0)) {
    // Sin layout real todavía — fallback razonable en vez de dejar el
    // panel fuera de vista; no reintenta porque el usuario ya pidió
    // abrirlo (a diferencia del trigger de leyenda, que se revela solo).
    wrapper.style.top   = "80px";
    wrapper.style.right = "60px";
    return;
  }

  const MARGEN_MINIMO = 8;

  // `right` deseado: justo a la izquierda de la columna nativa.
  const rightDeseado = window.innerWidth - rect.left + MARGEN_MINIMO;

  // offsetWidth requiere que el wrapper tenga layout — `hidden` en HTML
  // (a diferencia de display:none) no lo impide, coherente con el resto
  // de la app evitando display:none para elementos que necesitan medirse.
  const anchoWrapper   = wrapper.offsetWidth;
  const leftResultante = window.innerWidth - rightDeseado - anchoWrapper;

  if (leftResultante < MARGEN_MINIMO) {
    // El wrapper no cabe entre la columna nativa y el borde izquierdo del
    // viewport con la posición "ideal" — se ancla al margen mínimo en vez
    // de dejarlo recortado. Prioriza visibilidad completa sobre alineación
    // perfecta con la columna nativa.
    wrapper.style.left  = `${MARGEN_MINIMO}px`;
    wrapper.style.right = "auto";
  } else {
    wrapper.style.top   = `${rect.top}px`;
    wrapper.style.right = `${rightDeseado}px`;
    return;
  }

  wrapper.style.top = `${rect.top}px`;
}

// ─── Drag ─────────────────────────────────────────────────────────────────

/**
 * Arrastre por handle, coordenadas relativas al padre (offsetLeft/offsetTop),
 * no getBoundingClientRect — mezclar sistemas causa salto de posición al
 * iniciar el drag (decisión 14.07.26, ya validada en legendPanel.js).
 * Soporte mouse + touch.
 */
function _habilitarDrag(wrapper, handle) {
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  const onStart = (clientX, clientY) => {
    dragging = true;
    startX = clientX;
    startY = clientY;
    startLeft = wrapper.offsetLeft;
    startTop  = wrapper.offsetTop;
    // Fijar por left/top absoluto una vez que empieza el drag —
    // hasta ahora la posición inicial se dio por top/right.
    wrapper.style.left  = `${startLeft}px`;
    wrapper.style.right = "auto";
  };

  const onMove = (clientX, clientY) => {
    if (!dragging) return;
    wrapper.style.left = `${startLeft + (clientX - startX)}px`;
    wrapper.style.top  = `${startTop + (clientY - startY)}px`;
  };

  const onEnd = () => { dragging = false; };

  handle.addEventListener("mousedown", e => { onStart(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener("mousemove", e => onMove(e.clientX, e.clientY));
  window.addEventListener("mouseup", onEnd);

  handle.addEventListener("touchstart", e => {
    const t0 = e.touches[0];
    onStart(t0.clientX, t0.clientY);
  }, { passive: true });
  window.addEventListener("touchmove", e => {
    const t0 = e.touches[0];
    onMove(t0.clientX, t0.clientY);
  }, { passive: true });
  window.addEventListener("touchend", onEnd);
}