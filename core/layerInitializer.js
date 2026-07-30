/**
 * core/layerInitializer.js
 *
 * Aplica comportamiento runtime a capas ya creadas por layerFactory.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Dado el campo "disponibilidad_municipal" del catálogo y los datos del
 * municipio activo, configura cada capa para mostrar solo los datos
 * del municipio seleccionado.
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
 *   customLayerParameters con CQL_FILTER → servidor devuelve solo municipio.
 * FILTRABLE — FeatureLayer/WFS:
 *   definitionExpression con campo_filtro del catálogo.
 *   Requiere layer.load() para validar el esquema antes de aplicar filtro.
 *
 * DIRECTA:
 *   La URL ya incorpora el ámbito municipal. Sin filtro extra.
 *
 * CONSULTA:
 *   Solo GetFeatureInfo / identify. Sin filtro espacial.
 */

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Inicializa una capa aplicando los filtros correspondientes al municipio.
 *
* @param {Layer}  layer         - Instancia Esri creada por layerFactory
 * @param {Object} config        - Configuración de la capa en el catálogo
 * @param {Object} municipioData - Municipio activo, ya resuelto
 *   (ver territorioResolver.js). Forma: { codigo_ine, nombre,
 *   provincia_code, ccaa_code, bbox, polygon }
 * @returns {Promise<void>}
 */
export async function inicializarCapa(layer, config, municipioData) {
  if (!layer || !config || !municipioData) return;

  try {

    
    switch (config.disponibilidad_municipal) {

      case "BBOX":
        await _estrategiaBbox(layer, config, municipioData);
        break;

      case "FILTRABLE":
        await _estrategiaFiltrable(layer, config, municipioData);
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
 * @param {WFSLayer} layer         - Instancia WFSLayer (padre o hija)
 * @param {Object}   municipioData - Datos del municipio activo
 * @param {string}   [srsname="EPSG:4326"] - CRS declarado en el catálogo
 * @returns {Promise<void>}
 */
export async function aplicarBboxWfs(layer, municipioData, srsname = "EPSG:4326") {
  if (!layer || !municipioData?.bbox) return;

  const [xmin, ymin, xmax, ymax] = municipioData.bbox;
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

async function _estrategiaBbox(layer, config, municipioData) {
  const [xmin, ymin, xmax, ymax] = municipioData.bbox;
  const tipo = config.tipo;

  if (tipo === "WMS") {
    console.info(
      `[layerInitializer] WMS BBOX "${config.id}" → recorte visual delegado a máscara municipal`
    );

  } else if (tipo === "WFS") {
    // Delegar en la función pública para no duplicar lógica.
    // La misma función la usa layerTree para las capas hijas WFS discovery.
    const srsname = config.srsname ?? "EPSG:4326";
    await aplicarBboxWfs(layer, municipioData, srsname);

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

async function _estrategiaFiltrable(layer, config, municipioData) {
  const campoFiltro = config.campo_filtro;

  if (!campoFiltro) {
    console.warn(
      `[layerInitializer] Capa "${config.id}" es FILTRABLE pero no tiene campo_filtro en el catálogo`
    );
    return;
  }

  const tipo = config.tipo;

  if (tipo === "WMS") {
    layer.customLayerParameters = {
      CQL_FILTER: `${campoFiltro}='${municipioData.codigo_ine}'`
    };
    console.info(
      `[layerInitializer] WMS CQL_FILTER "${campoFiltro}='${municipioData.codigo_ine}'" → "${config.id}"`
    );

  } else if (tipo === "FEATURE" || tipo === "WFS") {
    try {
      await layer.load();
      layer.definitionExpression = `${campoFiltro} = '${municipioData.codigo_ine}'`;
      console.info(
        `[layerInitializer] definitionExpression "${layer.definitionExpression}" → "${config.id}"`
      );
    } catch (err) {
      console.warn(
        `[layerInitializer] No se pudo aplicar definitionExpression a "${config.id}":`, err
      );
    }
  }
}