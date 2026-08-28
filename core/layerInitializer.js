/**
 * core/layerInitializer.js
 *
 * Aplica comportamiento runtime a capas ya creadas por layerFactory.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Dado el campo "disponibilidad_municipal" del catálogo y los datos del
 * territorio activo (municipio, provincia o ccaa), configura cada capa
 * para mostrar solo los datos que corresponden a ese ámbito.
 *
 * ── ESTRATEGIAS DE FILTRADO ──────────────────────────────────────────────
 *
 * BBOX — WMS:
 *   El recorte visual lo gestiona la máscara de mapManager.
 * BBOX — WFS:
 *   customParameters.BBOX → filtro SERVIDOR real (OGC estándar).
 *   Función pública aplicarBboxWfs() reutilizable por layerTree para
 *   capas hijas WFS creadas dinámicamente via discovery.
 * BBOX — FEATURE:
 *   featureEffect declarativo (cliente). El servidor ArcGIS REST no
 *   acepta parámetros OGC; filtro real requiere definitionExpression.
 * BBOX — GeoJSON:
 *   Carga completa inevitable en cliente sin backend.
 *
 * FILTRABLE — WMS con soporte CQL_FILTER (GeoServer):
 *   customLayerParameters con CQL_FILTER → servidor devuelve solo el
 *   ámbito filtrado. El campo contra el que se filtra depende de
 *   config.filtro_nivel ("municipal" | "provincial" | "autonomico") —
 *   ver _CAMPO_POR_NIVEL más abajo.
 * FILTRABLE — FeatureLayer/WFS:
 *   definitionExpression con campo_filtro del catálogo, mismo criterio
 *   de nivel que WMS. Requiere layer.load() para validar el esquema
 *   antes de aplicar el filtro.
 *
 * DIRECTA:
 *   La URL ya incorpora el ámbito. Sin filtro extra.
 *
 * CONSULTA:
 *   Solo GetFeatureInfo / identify. Sin filtro espacial.
 *
 * ── AJUSTE (soporte de ámbito territorial) ─────────────────────────────────
 * Todo el módulo era ya agnóstico a la escala del bbox recibido — no sabía
 * ni necesitaba saber si trabajaba con un municipio o un territorio
 * completo. Este ajuste solo formaliza esa realidad en el naming
 * (municipioData → territorioData en firmas y JSDoc) y corrige el único
 * punto que SÍ asumía escala municipal: _estrategiaFiltrable(), que
 * construía el filtro contra codigo_ine de forma fija. Ahora lee
 * config.filtro_nivel para decidir contra qué campo filtrar.
 * 
 * /**
 * ── LIMITACIÓN CONOCIDA / MEJORA FUTURA (hallazgo 25.08.26, ver 3DECISIONS.md) ──
 *
 * Esta función solo distingue dos casos de proyección: EPSG:3857 (reproyecta
 * vía webMercatorUtils) o "cualquier otro valor" (asume WGS84 y envía el
 * bbox sin transformar). No es una reproyección genérica.
 *
 * Al automatizar la resolución del catálogo (enriquecer-catalogo.py, capa
 * data/), se confirmó que algunos servicios WFS reales declaran su
 * DefaultCRS/DefaultSRS en sistemas distintos a 4326/3857 — ej. el
 * Seccionado Estadístico del INE responde en EPSG:25830 (UTM 30N ETRS89).
 * Hoy esa capa cae en la rama "else" (se le envía el bbox en 4326 sin
 * transformar, como si el servicio hablara WGS84), lo que no rompe la
 * petición pero tampoco es correcto estrictamente — el filtro BBOX que
 * llega al servidor no está en su sistema de coordenadas real.
 *
 * No se corrige ahora porque el impacto práctico es bajo (el servidor
 * normalmente sigue devolviendo resultados utilizables, con un margen de
 * imprecisión en el recorte) y no había evidencia previa de que fuera
 * necesario — surge como hallazgo al automatizar la lectura de
 * GetCapabilities, no como bug reportado en producción.
 *
 * CAMINO PARA GENERALIZAR (cuando se priorice):
 *   webMercatorUtils solo sabe convertir WGS84 ↔ Web Mercator, por eso el
 *   switch actual es binario. Para soportar cualquier CRS declarado por
 *   el servicio (no solo 3857), el módulo correcto del SDK es
 *   esri/geometry/projection (no webMercatorUtils):
 *     - projection.load() — carga el motor de proyección (async, una vez)
 *     - projection.project(geometry, targetSpatialReference) — reproyecta
 *       a cualquier WKID, incluidos sistemas UTM/ETRS89 como 25830.
 *   Esto reemplazaría el if/else por: construir el Point en 4326 → cargar
 *   projection → project() al wkid real extraído de srsname → formatear
 *   bboxStr con ese resultado. Coste: projection.load() es más pesado que
 *   webMercatorUtils (carga más recursos del SDK), por eso no se adoptó
 *   de entrada — evaluar si el volumen de capas con CRS no estándar
 *   justifica el costo antes de implementarlo.
 
 */

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Inicializa una capa aplicando los filtros correspondientes al territorio activo.
 *
 * @param {Layer}  layer          - Instancia Esri creada por layerFactory
 * @param {Object} config         - Configuración de la capa en el catálogo
 * @param {Object} territorioData - Territorio activo (municipio, provincia o
 *   ccaa), ya resuelto. Forma: { codigo_ine, nombre, provincia_code,
 *   ccaa_code, bbox, polygon }. codigo_ine es null a nivel provincia/ccaa.
 * @returns {Promise<void>}
 */
export async function inicializarCapa(layer, config, territorioData) {
  if (!layer || !config || !territorioData) return;

  try {
    switch (config.disponibilidad_municipal) {

      case "BBOX":
        await _estrategiaBbox(layer, config, territorioData);
        break;

      case "FILTRABLE":
        await _estrategiaFiltrable(layer, config, territorioData);
        break;

      case "DIRECTA":
        console.info(`[layerInitializer] "${config.id}" DIRECTA — sin filtro extra`);
        break;

      case "CONSULTA":
        console.info(`[layerInitializer] "${config.id}" CONSULTA — visible, sin filtro espacial`);
        break;

      default:
        console.warn(
          `[layerInitializer] disponibilidad_municipal desconocida: ` +
          `"${config.disponibilidad_municipal}" en "${config.id}"`
        );
    }
  } catch (err) {
    console.error(`[layerInitializer] Error al inicializar capa "${config.id}":`, err);
  }
}

/**
 * Aplica el filtro BBOX de servidor a una WFSLayer.
 *
 * ── POR QUÉ ES PÚBLICA ───────────────────────────────────────────────────
 * Las capas WFS hijas creadas dinámicamente via discovery (layerTree) no
 * pasan por inicializarCapa() porque no tienen entrada en el catálogo.
 * layerTree las crea on-demand y necesita aplicarles el mismo filtro BBOX
 * que el padre. Exportar esta función evita duplicar lógica (DRY) y mantiene
 * la responsabilidad del filtrado en layerInitializer (SRP).
 *
 * @param {WFSLayer} layer          - Instancia WFSLayer (padre o hija)
 * @param {Object}   territorioData - Datos del territorio activo (municipio o
 *   territorio completo — solo se usa .bbox, agnóstico a la escala)
 * @param {string}   [srsname="EPSG:4326"] - CRS declarado en el catálogo
 * @returns {Promise<void>}
 */
export async function aplicarBboxWfs(layer, territorioData, srsname = "EPSG:4326") {
  if (!layer || !territorioData?.bbox) return;

  const [xmin, ymin, xmax, ymax] = territorioData.bbox;
  let bboxStr;

  try {
    if (srsname === "EPSG:3857") {
      // Servidor en Web Mercator → proyectar bbox desde WGS84.
      // El catálogo siempre almacena en 4326; la proyección es solo
      // adaptación en la petición HTTP, no modifica el catálogo.
      const [webMercatorUtils, Point] = await Promise.all([
        $arcgis.import("esri/geometry/support/webMercatorUtils"),
        $arcgis.import("esri/geometry/Point")
      ]);
      const sw = webMercatorUtils.geographicToWebMercator(
        new Point({ x: xmin, y: ymin, spatialReference: { wkid: 4326 } })
      );
      const ne = webMercatorUtils.geographicToWebMercator(
        new Point({ x: xmax, y: ymax, spatialReference: { wkid: 4326 } })
      );
      bboxStr = `${sw.x},${sw.y},${ne.x},${ne.y},EPSG:3857`;
    } else {
      // Servidor en WGS84 → bbox directo sin proyección
      bboxStr = `${xmin},${ymin},${xmax},${ymax},EPSG:4326`;
    }

    // customParameters.BBOX → filtro SERVIDOR real (OGC estándar).
    // El servicio WFS recibe el bbox en cada GetFeature request y devuelve
    // solo features que intersectan esa área.
    // Mucho más eficiente que featureEffect (cliente): el servidor no
    // transfiere datos fuera del bbox.
    layer.customParameters = { BBOX: bboxStr };

    console.info(
      `[layerInitializer] WFS BBOX "${layer.id}" → ${srsname} [${bboxStr}]`
    );

  } catch (err) {
    console.warn(
      `[layerInitializer] No se pudo aplicar BBOX a WFS "${layer.id}":`, err
    );
  }
}

/**
 * Recarga una capa (útil al cambiar de municipio sin recrear la instancia).
 * @param {Layer} layer
 */
export function recargarCapa(layer) {
  if (typeof layer?.refresh === "function") {
    layer.refresh();
    console.info(`[layerInitializer] Capa "${layer.id}" recargada`);
  }
}

/**
 * Tipos de capa con soporte de inicialización implementado.
 * @returns {string[]}
 */
export function getTiposImplementados() {
  return ["WMS", "WFS", "FEATURE", "GEOJSON"];
}

// ─── Estrategias privadas ─────────────────────────────────────────────────

async function _estrategiaBbox(layer, config, territorioData) {
  const [xmin, ymin, xmax, ymax] = territorioData.bbox;
  const tipo = config.tipo;

  if (tipo === "WMS") {
    console.info(
      `[layerInitializer] WMS BBOX "${config.id}" → recorte visual delegado a máscara municipal`
    );

  } else if (tipo === "WFS") {
    // Delegar en la función pública para no duplicar lógica.
    // La misma función la usa layerTree para las capas hijas WFS discovery.
    const srsname = config.srsname ?? "EPSG:4326";
    await aplicarBboxWfs(layer, territorioData, srsname);

  } else if (tipo === "FEATURE") {
    try {
      const [Extent, FeatureFilter] = await Promise.all([
        $arcgis.import("esri/geometry/Extent"),
        $arcgis.import("esri/layers/support/FeatureFilter")
      ]);
      const extent = new Extent({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } });
      layer.featureEffect = {
        filter:         new FeatureFilter({ geometry: extent, spatialRelationship: "intersects" }),
        excludedEffect: "opacity(0)",
        includedEffect: ""
      };
      console.info(`[layerInitializer] FEATURE BBOX declarado en "${config.id}"`);
    } catch (err) {
      console.warn(`[layerInitializer] No se pudo aplicar featureEffect a "${config.id}":`, err);
    }

  } else if (tipo === "GEOJSON") {
    console.info(
      `[layerInitializer] GeoJSON BBOX "${config.id}" → carga completa, recorte visual vía máscara`
    );
  }
}

/**
 * Mapa de nivel territorial → campo de territorioData contra el que se
 * compara el valor del filtro. Editable si en el futuro se añaden más
 * niveles (ej. "comarca" cuando se implemente).
 */
const _CAMPO_POR_NIVEL = {
  municipal:  "codigo_ine",
  provincial: "provincia_code",
  autonomico: "ccaa_code",
};

async function _estrategiaFiltrable(layer, config, territorioData) {
  const campoFiltro = config.campo_filtro;

  if (!campoFiltro) {
    console.warn(
      `[layerInitializer] Capa "${config.id}" es FILTRABLE pero no tiene campo_filtro en el catálogo`
    );
    return;
  }

  // filtro_nivel es nuevo en el catálogo — default "municipal" para
  // retrocompatibilidad total con capas ya existentes que no lo declaren
  // (ninguna hoy, pero no debe romper si aparece sin este campo).
  const nivel = config.filtro_nivel ?? "municipal";
  const campoTerritorio = _CAMPO_POR_NIVEL[nivel];

  if (!campoTerritorio) {
    console.warn(
      `[layerInitializer] filtro_nivel desconocido "${nivel}" en "${config.id}" — se omite filtro`
    );
    return;
  }

  const valorFiltro = territorioData[campoTerritorio];

  if (!valorFiltro) {
    // Caso esperado, no error: ej. una capa FILTRABLE a nivel "provincial"
    // evaluada con un territorioData de CCAA (provincia_code null).
    console.warn(
      `[layerInitializer] "${config.id}" requiere ${campoTerritorio} pero no está disponible en el territorio activo — se omite filtro`
    );
    return;
  }

  const tipo = config.tipo;

  if (tipo === "WMS") {
    layer.customLayerParameters = {
      CQL_FILTER: `${campoFiltro}='${valorFiltro}'`
    };
    console.info(
      `[layerInitializer] WMS CQL_FILTER "${campoFiltro}='${valorFiltro}'" (nivel ${nivel}) → "${config.id}"`
    );

  } else if (tipo === "FEATURE" || tipo === "WFS") {
    try {
      await layer.load();
      layer.definitionExpression = `${campoFiltro} = '${valorFiltro}'`;
      console.info(
        `[layerInitializer] definitionExpression "${layer.definitionExpression}" (nivel ${nivel}) → "${config.id}"`
      );
    } catch (err) {
      console.warn(
        `[layerInitializer] No se pudo aplicar definitionExpression a "${config.id}":`, err
      );
    }
  }
}