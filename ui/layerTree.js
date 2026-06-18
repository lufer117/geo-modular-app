/**
 * ui/layerTree.js
 *
 * Árbol de capas jerárquico basado en Calcite Tree Web Components.
 *
 * ── ESTRUCTURA DEL ÁRBOL ──────────────────────────────────────────────────
 *   bloque_tematico → nivel 1  (SIN checkbox, expandible, negrita)
 *   subtema         → nivel 2  (SIN checkbox, expandible)
 *   title (capa)    → nivel 3  (seleccionable → activa/desactiva la capa)
 *     └── [WFS sin name] → nivel 4  (FeatureTypes descubiertos via Capabilities)
 *                          (solo estos tienen checkbox efectivo)
 *
 * ── WFS CON DESCUBRIMIENTO DINÁMICO ──────────────────────────────────────
 * Cuando el catálogo tiene una entrada WFS sin campo "name", el servicio
 * puede exponer múltiples FeatureTypes. En lugar de hardcodear cada tipo
 * en el catálogo (una entrada por feature type → mantenimiento O(n)),
 * la app consulta el GetCapabilities del servicio al expandir el nodo
 * y construye los hijos dinámicamente.
 *
 * Ventaja académica: la app consume la autodescripción del servicio OGC
 * para construir la UI → se adapta automáticamente si el servidor añade
 * o quita tipos sin tocar el catálogo.
 *
 * Flujo:
 *   1. configEngine devuelve entrada WFS sin name → es un "nodo discovery"
 *   2. layerTree renderiza el nodo con indicador visual de expansión pendiente
 *   3. Usuario expande el nodo → calciteTreeItemExpand se dispara
 *   4. fetchFeatureTypes(url) → array de FeatureTypeInfo
 *   5. Se inyectan nodos hijo en el árbol (uno por FeatureType)
 *   6. Al activar un hijo → aplicarBboxWfs() + addCapa() (lazy)
 *
 * ── POR QUÉ selection-mode="ancestors" y NO calcite-checkbox manual ───────
 * calcite-tree-item intercepta todos los pointer events para su mecanismo
 * de selección nativo. Añadir calcite-checkbox como hijo provoca que el
 * click lo consuma el item antes de llegar al checkbox →
 * calciteCheckboxChange nunca se dispara.
 *
 * La solución correcta: usar el mecanismo nativo de Calcite Tree.
 *   - selection-mode="ancestors" → emite calciteTreeItemSelect en cada cambio
 *   - Un listener único en el árbol raíz (delegación de eventos)
 *   - data-layer-id + data-layer-index identifican qué capa toglear
 *   - Los grupos (nivel 1 y 2) no tienen data-layer-id → el listener los ignora
 *
 * ── REACTIVIDAD ───────────────────────────────────────────────────────────
 * El árbol se reconstruye completamente al recibir "municipio-cargado".
 * Árbol limpio por municipio → sin riesgo de estado inconsistente.
 */

import { on, emit }        from "../utils/eventBus.js";
import { clearContainer }  from "../utils/domUtils.js";
import * as mapManager     from "../core/mapManager.js";
import { crearCapaWfsHija } from "../core/layerFactory.js";
import { aplicarBboxWfs }  from "../core/layerInitializer.js"; // ← CAMBIO: importar helper de filtrado
import { fetchFeatureTypes, checkFeaturesInBbox } from "../utils/wfsCapabilitiesParser.js";

// ─── Estado interno del módulo ────────────────────────────────────────────

let _containerEl   = null;
let _layersRef     = [];
let _configsRef    = [];
let _lazyLayerIds  = new Set();

// ← CAMBIO: guardar municipioData para aplicar BBOX a las capas hijas WFS
// creadas on-demand en _crearHijoWfs(). Las hijas no pasan por
// inicializarCapa() porque no tienen entrada en el catálogo; necesitamos
// el contexto del municipio activo para filtrarlas igual que al padre.
let _municipioData = null;

/**
 * Conjunto de IDs de nodos WFS "discovery" que ya han sido expandidos.
 * Evita lanzar múltiples peticiones GetCapabilities si el usuario colapsa
 * y vuelve a expandir el mismo nodo.
 * Clave: config.id del padre. Valor: true (ya expandido).
 */
const _wfsDiscoveryExpanded = new Map();

// ─── Inicialización ────────────────────────────────────────────────────────

export function initLayerTree(container) {
  _containerEl = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!_containerEl) {
    console.error("[layerTree] Contenedor no encontrado:", container);
    return;
  }

  // Mensaje inicial — layerTree es dueño único de este contenedor.
  // Se elimina en _renderTree via clearContainer cuando llegue municipio-cargado.
  // const msg = document.createElement("p");
  // msg.className   = "layer-tree-empty";
  // msg.textContent = "Selecciona un municipio para ver las capas disponibles.";
  // _containerEl.appendChild(msg);

  // ← CAMBIO: desestructurar también municipioData del evento
  on("municipio-cargado", ({ layers, configs, lazyLayerIds, municipioData }) => {
    // Limpiar el estado de discovery al cambiar de municipio.
    // Un municipio nuevo puede tener las mismas URLs WFS pero con distinto contexto.
    _wfsDiscoveryExpanded.clear();
    _municipioData = municipioData ?? null; // ← CAMBIO: actualizar contexto municipal
    _renderTree(layers, configs, lazyLayerIds ?? new Set());
  });
}

// ─── Renderizado principal ─────────────────────────────────────────────────

function _renderTree(layers, configs, lazyLayerIds) {
  // CRÍTICO: limpiar el contenedor antes de renderizar.
  clearContainer(_containerEl);

  _lazyLayerIds = lazyLayerIds;
  _layersRef    = layers;
  _configsRef   = configs;

  if (!configs || configs.length === 0) {
    const msg = document.createElement("p");
    msg.className   = "layer-tree-empty";
    msg.textContent = "Sin capas disponibles para este municipio.";
    _containerEl.appendChild(msg);
    return;
  }

  const grupos = _agrupar(configs, layers);

  const tree = document.createElement("calcite-tree");
  tree.setAttribute("selection-mode", "multiple");
  tree.setAttribute("lines", "");

  // ── Listener de selección (toggle visibilidad) ─────────────────────────
  // Delegación de eventos: un único listener en la raíz captura los eventos
  // de todos los nodos hoja. Los nodos agrupadores y nodos WFS discovery
  // no tienen data-layer-id → el listener los ignora.
  tree.addEventListener("calciteTreeItemSelect", e => {
    _handleLayerSelect(e);
  });

  // ── Listener de expansión (discovery WFS) ─────────────────────────────
  // calciteTreeItemExpand se dispara cuando el usuario abre un nodo.
  // Solo actuamos si el nodo es un "discovery WFS" pendiente de expansión.
  tree.addEventListener("calciteTreeItemExpand", e => {
    const item = e.target;
    if (item.dataset.wfsDiscovery === "true") {
      _handleWfsDiscovery(item);
    }
  });

  grupos.forEach(({ bloque, subtemas }) => {
    const bloqueItem     = _crearItemGrupo(bloque, true);
    const bloqueChildren = document.createElement("calcite-tree");
    bloqueChildren.slot  = "children";

    subtemas.forEach(({ subtema, pares }) => {
      const subtemaItem     = _crearItemGrupo(subtema, false);
      const subtemaChildren = document.createElement("calcite-tree");
      subtemaChildren.slot  = "children";

      pares.forEach(({ config, layer }) => {
        const globalIndex = configs.indexOf(config);

        // ── Nodo WFS sin name: discovery mode ─────────────────────────
        // Una entrada WFS sin campo "name" en el catálogo es un servicio
        // con múltiples FeatureTypes. Se renderiza como nodo expandible
        // que cargará sus hijos dinámicamente al abrirse.
        if (config.tipo === "WFS" && !config.name) {
          subtemaChildren.appendChild(
            _crearItemWfsDiscovery(config, globalIndex)
          );
        } else {
          // Nodo hoja estándar (WMS, WMTS, WFS con name, GeoJSON…)
          subtemaChildren.appendChild(
            _crearItemCapa(config, layer, globalIndex)
          );
        }
      });

      subtemaItem.appendChild(subtemaChildren);
      bloqueChildren.appendChild(subtemaItem);
    });

    bloqueItem.appendChild(bloqueChildren);
    tree.appendChild(bloqueItem);
  });

  _containerEl.appendChild(tree);
  console.info(`[layerTree] Árbol renderizado: ${configs.length} capas`);
}

// ─── Handlers de eventos ──────────────────────────────────────────────────

/**
 * Gestiona la activación/desactivación de una capa hoja.
 * Se llama desde el listener de calciteTreeItemSelect.
 */
function _handleLayerSelect(e) {
  const item = e.target.closest("calcite-tree-item[data-layer-id]");
  if (!item) return;

  const layerId    = item.dataset.layerId;
  const layerIndex = item.dataset.layerIndex;

  // Nodo hijo WFS (instancia creada on-demand): no tiene índice global
  // porque no estaba en el array original de configs/layers.
  // Se gestiona en _handleWfsHijoSelect.
  if (item.dataset.wfsHijo === "true") {
    _handleWfsHijoSelect(item, layerId);
    return;
  }

  const globalIndex = parseInt(layerIndex, 10);
  // Calcite actualiza "selected" antes de emitir el evento.
  const visible = !item.hasAttribute("selected");

  const layer  = _layersRef[globalIndex];
  const config = _configsRef[globalIndex];

  if (!layer) {
    console.warn(`[layerTree] Layer no encontrada para índice ${globalIndex}`);
    return;
  }

  // Lazy-load: la capa entra al mapa solo la primera vez que se activa.
  if (visible && _lazyLayerIds.has(layerId) && !layer.map) {
    mapManager.addCapa(layer);
  }

  layer.visible = visible;
  emit(visible ? "capa-activada" : "capa-desactivada", { layerId, layer, config });
  console.info(`[layerTree] "${layerId}" → visible: ${visible}`);
}

/**
 * Activa/desactiva un FeatureLayer hijo de un nodo WFS discovery.
 *
 * @param {HTMLElement} item   - El calcite-tree-item del hijo
 * @param {string}      hijoId - ID derivado: "{padreId}::{featureType.name}"
 */
function _handleWfsHijoSelect(item, hijoId) {
  const visible = !item.hasAttribute("selected");

  // La instancia de capa se almacena en el propio nodo DOM como referencia.
  // Esto evita un Map externo y mantiene el estado colocado junto al elemento
  // que lo necesita. Se asigna en _crearHijoWfs cuando se crean los hijos.
  const layer = item._layerInstance;

  if (!layer) {
    console.warn(`[layerTree] Capa WFS hija sin instancia: "${hijoId}"`);
    return;
  }

  // Lazy: añadir al mapa solo la primera vez que se activa
  if (visible && !layer.map) {
    mapManager.addCapa(layer);
  }

  layer.visible = visible;
  emit(visible ? "capa-activada" : "capa-desactivada", {
    layerId: hijoId,
    layer,
    // Config sintético mínimo para que legendPanel pueda identificar la capa
    config: { id: hijoId, title: layer.title, tipo: "WFS" }
  });
  console.info(`[layerTree] WFS hijo "${hijoId}" → visible: ${visible}`);
}

/**
 * Gestiona la expansión de un nodo WFS discovery.
 * Se llama la primera vez que el usuario expande el nodo.
 * Las expansiones siguientes no relanza el fetch (caché en _wfsDiscoveryExpanded).
 *
 * @param {HTMLElement} item - El calcite-tree-item del nodo padre WFS
 */
async function _handleWfsDiscovery(item) {
  const configId = item.dataset.configId;

  // Idempotencia: si ya se expandió, no relanzar el fetch.
  if (_wfsDiscoveryExpanded.has(configId)) return;
  _wfsDiscoveryExpanded.set(configId, true);

  const config = _configsRef.find(c => c.id === configId);
  if (!config) {
    console.error(`[layerTree] Config no encontrada para discovery: "${configId}"`);
    return;
  }

  // Obtener el slot de hijos (el calcite-tree anidado dentro del item)
  const childrenTree = item.querySelector("calcite-tree[slot='children']");
  if (!childrenTree) {
    console.error(`[layerTree] No se encontró slot children en nodo "${configId}"`);
    return;
  }

  // Mostrar spinner mientras carga
  _setDiscoveryState(item, childrenTree, "loading");

  try {
    const featureTypes = await fetchFeatureTypes(config.url);

    if (featureTypes.length === 0) {
      _setDiscoveryState(item, childrenTree, "empty");
      return;
    }

    clearContainer(childrenTree);
    _setDiscoveryState(item, childrenTree, "loading"); // para que spinner sea visible hasta que los hijos estén listos

    // ── Verificar disponibilidad espacial en paralelo ─────────────────────
    // Por qué en paralelo: con N FeatureTypes, el tiempo total pasa de
    // O(N × latencia_red) a O(latencia_max). Con 5 tipos y ~300ms/req:
    //   serie → ~1.500ms | paralelo → ~300ms
    //
    // checkFeaturesInBbox nunca rechaza (captura internamente todos los errores),
    // por lo que Promise.all es seguro sin .catch adicional.
    const bbox = _municipioData?.bbox ?? null;

    let availabilityMap; // Map<nombre_featureType, boolean>

    if (bbox) {
      // const checks  = featureTypes.map(ft => checkFeaturesInBbox(config.url, ft.name, bbox));
      // const results = await Promise.all(checks);
      
        const results = await _checkConPool(featureTypes, config.url, bbox, {
          concurrencia: 4   // mismo valor conservador, sin pausa artificial
        });
        availabilityMap = new Map(featureTypes.map((ft, i) => [ft.name, results[i]]));
    } else {
      // Sin bbox no podemos filtrar → asumir disponibles (degradación segura)
      console.warn("[layerTree] _municipioData.bbox no disponible; omitiendo check BBOX");
      // availabilityMap = new Map(featureTypes.map(ft => [ft.name, true]));
      availabilityMap = new Map(featureTypes.map((ft, i) => [ft.name, results[i]]));
    }

    // Crear instancias y nodos DOM en paralelo.
    // _crearHijoWfs recibe el flag de disponibilidad: si es false, renderiza
    // el nodo como deshabilitado con chip informativo y omite la instancia de capa.
    const hijos = await Promise.all(
      featureTypes.map(ft => _crearHijoWfs(ft, config, availabilityMap.get(ft.name) ?? false))
    );

    // Limpiar el spinner antes de añadir los hijos
    clearContainer(childrenTree); // espera los hijos antes de limpiar para evitar parpadeo excesivo si la carga es rápida

    hijos.forEach(({ item: hijoItem }) => {
      if (hijoItem) childrenTree.appendChild(hijoItem);
    });

    console.info(
      `[layerTree] WFS discovery "${configId}": ${featureTypes.length} FeatureTypes`
    );

  } catch (err) {
    console.error(`[layerTree] Error al expandir WFS "${configId}":`, err);
    _setDiscoveryState(item, childrenTree, "error");
  }
}

// ─── Construcción de items ─────────────────────────────────────────────────

/**
 * Crea el nodo Calcite para un agrupador (bloque temático o subtema).
 * Sin data-layer-id → el listener de selección lo ignora.
 */
function _crearItemGrupo(label, negrita) {
  const item = document.createElement("calcite-tree-item");
  // item.setAttribute("expanded", ""); // Opcional: expandir por defecto los grupos (puede ser mucho contenido)

  const span = document.createElement("span");
  span.className   = negrita
    ? "layer-group-label layer-group-bloque"
    : "layer-group-label";
  span.textContent = label;
  item.appendChild(span);

  return item;
}

/**
 * Crea el nodo Calcite para una capa hoja estándar (con data-layer-id).
 */
function _crearItemCapa(config, layer, globalIndex) {
  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId    = config.id;
  item.dataset.layerIndex = globalIndex;

  if (layer.visible) {
    item.setAttribute("selected", "");
  }

  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = config.title;
  item.appendChild(span);

  // _añadirBadges(item, config);

  return item;
}

/**
 * Crea el nodo Calcite para un servicio WFS en modo discovery.
 *
 * ── DISEÑO DEL NODO DISCOVERY ────────────────────────────────────────────
 * El nodo debe:
 *   a) Ser expandible (para disparar calciteTreeItemExpand)
 *   b) NO ser seleccionable como capa (no tiene data-layer-id)
 *   c) Tener un slot "children" vacío pero presente (Calcite lo necesita
 *      para mostrar el chevron de expansión incluso con hijos vacíos)
 *   d) Mostrar indicador visual de que tiene contenido pendiente de cargar
 *
 * El atributo data-wfs-discovery="true" identifica estos nodos para el
 * listener de calciteTreeItemExpand.
 *
 * @param {Object} config      - Config del catálogo (tipo WFS, sin name)
 * @param {number} globalIndex - Índice en _configsRef (para trazabilidad)
 */
function _crearItemWfsDiscovery(config, globalIndex) {
  const item = document.createElement("calcite-tree-item");
  // NO añadir data-layer-id: este nodo no activa/desactiva una capa directa.
  // El listener de selección lo ignorará.
  item.dataset.wfsDiscovery = "true";
  item.dataset.configId     = config.id;
  // Opcional Expandido por defecto para descubrir sus hijos al cargar
  // item.setAttribute("expanded", "");

  // Etiqueta con icono de servicio WFS para diferenciarlo visualmente
  const label = document.createElement("span");
  label.className   = "layer-label layer-label--wfs-service";
  label.textContent = config.title;
  item.appendChild(label);

  // Badge que indica que los hijos se cargarán dinámicamente
  const badge = document.createElement("calcite-chip");
  badge.setAttribute("scale", "s");
  badge.setAttribute("kind", "neutral");
  badge.setAttribute("icon", "data-magnifying-glass");
  badge.textContent = "WFS";
  item.appendChild(badge);

  // _añadirBadges(item, config); //opcional: añadir badges de prioridad/INSPIREy

  // Slot de hijos: debe existir vacío para que Calcite muestre el chevron.
  // Se rellena con el spinner o los FeatureTypes en _setDiscoveryState/_handleWfsDiscovery.
  const childrenTree = document.createElement("calcite-tree");
  childrenTree.slot  = "children";

  // Spinner inicial (visible mientras no se haya expandido)
  const spinner = document.createElement("calcite-loader");
  spinner.setAttribute("scale", "s");
  spinner.setAttribute("inline", "");
  spinner.setAttribute("text", "Cargando tipos...");
  childrenTree.appendChild(spinner);

  item.appendChild(childrenTree);

  return item;
}

/**
 * Crea el nodo Calcite para un FeatureType hijo de un nodo WFS discovery,
 * crea la instancia WFSLayer correspondiente, y le aplica el filtro BBOX
 * del municipio activo antes de que entre al mapa.
 *
 * ── POR QUÉ SE APLICA BBOX AQUÍ ──────────────────────────────────────────
 * La hija no tiene entrada en el catálogo → no pasa por inicializarCapa().
 * aplicarBboxWfs() es la función pública de layerInitializer que encapsula
 * la lógica de filtrado servidor OGC. Llamarla aquí respeta el SRP:
 *   - layerFactory  → solo instancia
 *   - layerInitializer → único dueño de la lógica de filtrado (DRY)
 *   - layerTree     → orquesta UI y llama al filtrado con el contexto disponible
 *
 * La instancia se almacena en item._layerInstance para acceso O(1) desde
 * _handleWfsHijoSelect sin necesitar un Map externo.
 *
 * @param {import('../utils/wfsCapabilitiesParser.js').FeatureTypeInfo} featureType
 * @param {Object} configPadre - Config del catálogo del servicio padre
 * @returns {Promise<{item: HTMLElement, layer: WFSLayer|null}>}
 */
async function _crearHijoWfs(featureType, configPadre, disponible = true) {
  const hijoId = `${configPadre.id}::${featureType.name}`;

  // ── Cortocircuito: sin datos en este municipio ────────────────────────
  // No instanciamos la WFSLayer porque no hay nada que añadir al mapa.
  // El nodo se renderiza deshabilitado con un chip informativo para que
  // el usuario sepa que el tipo existe pero no tiene cobertura aquí.
  if (!disponible) {
     const item = document.createElement("calcite-tree-item");
  item.dataset.layerId = hijoId;
  item.dataset.wfsHijo = "true";
  item.setAttribute("disabled", "");
  
  // Tooltip nativo (visible al hacer hover)
  item.title = `${featureType.name} — sin datos en este municipio`;

  const label = document.createElement("span");
  label.className   = "layer-label";
  label.textContent = featureType.title || featureType.name;
  item.appendChild(label);

  return { item, layer: null };
    
  }

  // Crear la instancia de capa antes de crear el nodo DOM.
  // Si falla, el nodo mostrará un estado de error en lugar de quedar huérfano.
  const layer = await crearCapaWfsHija(featureType, configPadre);


  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId = hijoId;
  item.dataset.wfsHijo = "true"; // Identificador para _handleLayerSelect

  if (!layer) {
    // La capa no pudo crearse: mostrar el nodo como deshabilitado
    item.setAttribute("disabled", "");
    const span = document.createElement("span");
    span.className   = "layer-label layer-label--error";
    span.textContent = featureType.title;
    item.appendChild(span);

    const errorChip = document.createElement("calcite-chip");
    errorChip.setAttribute("scale", "s");
    errorChip.setAttribute("kind", "danger");
    errorChip.textContent = "Error";
    item.appendChild(errorChip);

    return { item, layer: null };
  }

  // Aplicar BBOX al hijo antes de que entre al mapa.
  // La hija hereda el srsname del configPadre (que sí está en el catálogo).
  // El filtro debe aplicarse ANTES de map.add() para que el primer
  // GetFeature request ya lleve el parámetro BBOX al servidor.
  if (_municipioData) {
    await aplicarBboxWfs(layer, _municipioData, configPadre.srsname ?? "EPSG:4326");
  }

  // Almacenar referencia directa en el nodo DOM para acceso O(1) desde el listener
  item._layerInstance = layer;

  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = featureType.title;
  item.appendChild(span);

  // Mostrar el nombre técnico como tooltip para que el usuario pueda
  // identificar el FeatureType exacto en caso de necesitar referenciarlo
  if (featureType.name !== featureType.title) {
    item.title = featureType.name;
  }

  // CRS como indicador informativo si es relevante (no WGS84)
  if (featureType.crs && !featureType.crs.includes("4326") && !featureType.crs.includes("4258")) {
    const crsChip = document.createElement("calcite-chip");
    crsChip.setAttribute("scale", "s");
    crsChip.setAttribute("kind", "neutral");
    crsChip.textContent = featureType.crs.replace(/.*:/, "EPSG:");
    item.appendChild(crsChip);
  }

  return { item, layer };
}

// ─── Estado visual del nodo discovery ────────────────────────────────────

/**
 * Actualiza el contenido del slot de hijos de un nodo WFS discovery
 * según el estado actual de la petición Capabilities.
 *
 * @param {HTMLElement} parentItem   - El calcite-tree-item del padre WFS
 * @param {HTMLElement} childrenTree - El calcite-tree slot="children"
 * @param {"loading"|"empty"|"error"} state
 */
function _setDiscoveryState(parentItem, childrenTree, state) {
  clearContainer(childrenTree);

  const messages = {
    loading: { icon: null,          text: "Cargando tipos de capa...",            chip: null      },
    empty:   { icon: "information", text: "Sin FeatureTypes disponibles",         chip: "neutral" },
    error:   { icon: "exclamation", text: "No se pudo conectar con el servicio",  chip: "danger"  }
  };

  const { icon, text, chip } = messages[state] ?? messages.error;

  if (state === "loading") {
    const spinner = document.createElement("calcite-loader");
    spinner.setAttribute("scale", "s");
    spinner.setAttribute("inline", "");
    spinner.setAttribute("text", text);
    childrenTree.appendChild(spinner);
    return;
  }

  // Para empty y error: un item informativo no seleccionable
  const infoItem = document.createElement("calcite-tree-item");
  infoItem.setAttribute("disabled", "");

  const span = document.createElement("span");
  span.className   = `layer-label layer-label--${state}`;
  span.textContent = text;
  infoItem.appendChild(span);

  if (chip) {
    const chipEl = document.createElement("calcite-chip");
    chipEl.setAttribute("scale", "s");
    chipEl.setAttribute("kind", chip);
    if (icon) chipEl.setAttribute("icon", icon);
    chipEl.textContent = state === "empty" ? "Vacío" : "Error";
    infoItem.appendChild(chipEl);
  }

  childrenTree.appendChild(infoItem);
}

// ─── Agrupación ───────────────────────────────────────────────────────────

function _agrupar(configs, layers) {
  const bloqueMap = new Map();

  configs.forEach((config, i) => {
    const bloque  = config.bloque_tematico ?? "Sin categoría";
    const subtema = config.subtema         ?? "General";

    if (!bloqueMap.has(bloque)) bloqueMap.set(bloque, new Map());
    const subtemaMap = bloqueMap.get(bloque);
    if (!subtemaMap.has(subtema)) subtemaMap.set(subtema, []);
    subtemaMap.get(subtema).push({ config, layer: layers[i] });
  });

  return Array.from(bloqueMap.entries()).map(([bloque, subtemaMap]) => ({
    bloque,
    subtemas: Array.from(subtemaMap.entries()).map(([subtema, pares]) => ({
      subtema,
      pares
    }))
  }));
}

// ─── Helpers privados ─────────────────────────────────────────────────────

/**
 * Pool de concurrencia fija para checkFeaturesInBbox.
 * 
 * Por qué pool en vez de lotes con pausa:
 * - Los lotes con pausa fija desperdician tiempo cuando el servidor responde rápido
 *   (INE responde en ~80ms pero el lote espera 500ms igualmente).
 * - El pool mantiene exactamente `concurrencia` peticiones activas en todo momento:
 *   en cuanto una termina, la siguiente arranca sin esperar al resto del lote.
 * - Mismo control de carga para servidores lentos (Fomento/ArcGIS gubernamental),
 *   sin penalizar a los servidores rápidos (INE/GeoServer).
 * 
 * @param {FeatureTypeInfo[]} featureTypes
 * @param {string} serviceUrl
 * @param {number[]} bbox
 * @param {object} opciones
 * @param {number} opciones.concurrencia - Máximo de peticiones simultáneas (default: 4)
 * @returns {Promise<boolean[]>} - Array de disponibilidad, mismo orden que featureTypes
 */
async function _checkConPool(featureTypes, serviceUrl, bbox, { concurrencia = 4 } = {}) {
  const resultados = new Array(featureTypes.length);
  let siguiente = 0;

  // Cada "worker" es una cadena de promesas que consume el array de trabajo
  // hasta agotarlo. Se lanzan `concurrencia` workers en paralelo.
  async function worker() {
    while (true) {
      // Reserva atómica del siguiente índice pendiente
      const idx = siguiente++;
      if (idx >= featureTypes.length) break;

      resultados[idx] = await checkFeaturesInBbox(
        serviceUrl,
        featureTypes[idx].name,
        bbox
      );
    }
  }

  // Lanza exactamente `concurrencia` workers concurrentes
  const workers = Array.from({ length: Math.min(concurrencia, featureTypes.length) }, worker);
  await Promise.all(workers);

  return resultados;
}

/**
 * Añade badges visuales (P0, INSPIRE) a un calcite-tree-item.
 * Extraído para reutilizarlo en nodos estándar y nodos discovery.
 */
// function _añadirBadges(item, config) {
//   if (config.prioridad === "P0 - MVP") {
//     const badge = document.createElement("calcite-chip");
//     badge.setAttribute("scale", "s");
//     badge.setAttribute("kind", "brand");
//     badge.textContent = "P0";
//     item.appendChild(badge);
//   }

//   if (config.inspire) {
//     const chip = document.createElement("calcite-chip");
//     chip.setAttribute("scale", "s");
//     chip.setAttribute("kind", "neutral");
//     chip.textContent = "INSPIRE";
//     item.appendChild(chip);
//   }
// }