/**
 * core/ambito/estrategiaSupramunicipal.js
 *
 * Estrategia de ámbito SUPRAMUNICIPAL (ambitoTerritorial "provincia" | "ccaa",
 * y en el futuro "comarca").
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────
 * Existe un territorio superior (Diputación, Gobierno regional) con una BASE
 * territorial que no debe destruirse cada vez que el usuario prueba un
 * municipio. Por eso la carga es incremental:
 *
 *   cargaAutomatica() → false: el usuario elige explícitamente el municipio
 *   iniciar()         → carga la base territorial (capas + máscara + zoom)
 *   seleccionar(ine)  → SUMA las capas municipales y resalta el municipio
 *   limpiar()         → retira lo sumado y vuelve a la vista territorial
 *
 * ── RESALTADO EN LUGAR DE MÁSCARA ────────────────────────────────────────
 * Al elegir un municipio no se toca la máscara territorial: la base sigue
 * siendo el territorio completo. El municipio en foco se señala con un
 * contorno independiente (mapManager.resaltarMunicipio).
 *
 * ── DEPENDENCIAS ─────────────────────────────────────────────────────────
 * No importa nada de ui/. La UI llega como callbacks:
 *   ui.setLoading(bool)   → spinner del selector
 *   ui.limpiarSeleccion() → deja el combobox visualmente sin selección
 */

import * as configEngine   from "../../config/configEngine.js";
import * as mapManager     from "../mapManager.js";
import { construirCapas }  from "./cargaCapas.js";
import { emit }            from "../../utils/eventBus.js";

/**
 * @param {Object}   contexto
 * @param {Object[]} contexto.municipiosDisponibles - Resueltos por territorioResolver
 * @param {Object}   contexto.mascaraInicial        - { bbox, polygon, provincia_code,
 *   ccaa_code, codigo_ine: null } del territorio completo
 * @param {{setLoading?: Function, limpiarSeleccion?: Function}} [contexto.ui]
 */
export function crearEstrategiaSupramunicipal({ municipiosDisponibles, mascaraInicial, ui }) {
  const { setLoading = () => {}, limpiarSeleccion = () => {} } = ui ?? {};

  // Se conserva aquí porque limpiar() necesita volver a la máscara/zoom
  // territorial sin volver a llamar a territorioResolver.
  const territorioData = mascaraInicial;

  let cargando        = false;
  let municipioActivo = null;
  // Ids de las capas municipales añadidas: limpiar() sabe exactamente qué
  // quitar del mapa sin afectar la base territorial.
  let capasMunicipioActivas = [];

  async function iniciar() {
    if (!territorioData) {
      console.warn("[ámbito supramunicipal] Sin territorio inicial: no se carga la base territorial");
      return;
    }
    if (cargando) return;

    cargando = true;
    setLoading(true);

    try {
      console.info("[ámbito supramunicipal] → Cargando base territorial");

      const configs = await configEngine.fetchCapasTerritoriales(territorioData);

      if (configs.length === 0) {
        console.warn("[ámbito supramunicipal] Sin capas territoriales para este ámbito");
        return;
      }

      const { layers, cfgList, lazyLayerIds, capasInmediatas } =
        await construirCapas(configs, territorioData);

      // Primera carga → reemplazo seguro, no hay nada que preservar aún.
      mapManager.addCapas(capasInmediatas);

      await mapManager.actualizarMascara(territorioData.polygon);
      await mapManager.irAlMunicipio(territorioData.bbox);

      emit("territorio-cargado", {
        territorioData,
        layers,
        configs: cfgList,
        lazyLayerIds
      });

      console.info(`[ámbito supramunicipal] ✓ ${layers.length} capas territoriales base cargadas`);

    } catch (err) {
      console.error("[ámbito supramunicipal] Error al cargar la base territorial:", err);
    } finally {
      cargando = false;
      setLoading(false);
    }
  }

  async function seleccionar(codigoIne) {
    if (!codigoIne || cargando) return;

    const municipioData = municipiosDisponibles.find(m => m.codigo_ine === codigoIne);
    if (!municipioData) return;

    // Cambiar de municipio dentro del mismo territorio: retirar el anterior
    // antes de añadir el nuevo, para no acumular capas de dos municipios.
    if (municipioActivo && municipioActivo !== codigoIne) {
      await retirar({ mantenerZoomTerritorial: true });
    }

    municipioActivo = codigoIne;
    cargando = true;
    setLoading(true);

    try {
      console.info(`[ámbito supramunicipal] + Agregando capas municipales: ${municipioData.nombre}`);

      emit("municipio-seleccionado", { municipioData });

      const configs = await configEngine.fetchCapasMunicipales(municipioData);

      if (configs.length === 0) {
        console.info(`[ámbito supramunicipal] "${municipioData.nombre}" no tiene capas municipales propias`);
        // Aun sin capas nuevas, el zoom y el resaltado siguen teniendo sentido:
        // son señal visual de foco, independiente del catálogo. No se emite
        // capas-municipio-agregadas vacío (layerTree no debe procesar nada).
        await mapManager.irAlMunicipio(municipioData.bbox);
        await mapManager.resaltarMunicipio(municipioData.polygon);
        return;
      }

      const { layers, cfgList, lazyLayerIds } =
        await construirCapas(configs, municipioData);

      // addCapa() singular, en bucle: addCapas() (plural) reemplazaría toda
      // la base territorial. Aquí solo se suma.
      layers.forEach((layer, i) => {
        if (cfgList[i].tipo !== "WFS") {
          mapManager.addCapa(layer);
        }
      });

      // Sin tocar la máscara territorial: solo zoom al municipio y resaltado.
      await mapManager.irAlMunicipio(municipioData.bbox);
      await mapManager.resaltarMunicipio(municipioData.polygon);

      capasMunicipioActivas = cfgList.map(c => c.id);

      emit("capas-municipio-agregadas", {
        municipioData,
        layers,
        configs: cfgList,
        lazyLayerIds
      });

      console.info(
        `[ámbito supramunicipal] ✓ ${layers.length} capas municipales agregadas para "${municipioData.nombre}"`
      );

    } catch (err) {
      console.error("[ámbito supramunicipal] Error al agregar capas municipales:", err);
    } finally {
      cargando = false;
      setLoading(false);
    }
  }

  /**
   * Inverso exacto de seleccionar(): retira solo lo añadido, quita el
   * resaltado y (salvo que se indique lo contrario) vuelve a máscara/zoom
   * territorial. mantenerZoomTerritorial lo usa seleccionar() al pasar de un
   * municipio a otro, porque el siguiente zoom lo hará ella misma.
   */
  async function retirar({ mantenerZoomTerritorial = false } = {}) {
    if (capasMunicipioActivas.length === 0 && !municipioActivo) return;

    const map = mapManager.getMap();
    const idsARetirar = [...capasMunicipioActivas];

    if (map) {
      const capasARemover = map.layers
        .filter(l => idsARetirar.includes(l.id))
        .toArray();
      map.layers.removeMany(capasARemover);
    }

    // El resaltado se retira siempre: evita un parpadeo del contorno viejo
    // mientras seleccionar() del siguiente municipio resuelve sus capas.
    mapManager.quitarResaltadoMunicipio();

    emit("capas-municipio-retiradas", { layerIds: idsARetirar });

    capasMunicipioActivas = [];
    municipioActivo = null;

    if (!mantenerZoomTerritorial && territorioData) {
      await mapManager.actualizarMascara(territorioData.polygon);
      await mapManager.irAlMunicipio(territorioData.bbox);
    }

    // Sincroniza el combobox de vuelta a "sin selección" por si se llegó aquí
    // desde un origen distinto al propio change del combobox.
    limpiarSeleccion();

    console.info(`[ámbito supramunicipal] − ${idsARetirar.length} capas municipales retiradas`);
  }

  return {
    tipo: "supramunicipal",

    cargaAutomatica() {
      return false;
    },

    iniciar,
    seleccionar,

    async limpiar() {
      await retirar();
    },

    getMunicipioActivo() {
      return municipioActivo;
    }
  };
}