// layers.js
// ============================================================
// SISTEMA DE CONFIGURACIÓN
// Único archivo que cambia entre municipios.
// Estructura: array de GRUPOS → cada grupo contiene capas.
// sublayers: null → carga todas las sublayers de la capa
// visible: false → apaga al inicio
// subLayersVisible: false → sublayers WMS apagadas al inicio.
// El usuario activa individualmente lo que necesita.
// ============================================================

export const CAPAS_CONFIG = [
  {
    id:     "grupo-catastro",
    title:  "Catastro y Edificación",
    tipo:   "GRUPO",
    visible: true,
    visibilityMode: "independent",// "independent" → checkboxes, cada capa se activa sola
    capas: [
      {
        id:            "catastro-parcelas",
        title:         "Parcelas Catastrales",
        tipo:          "WMS",
        url:           "https://ovc.catastro.meh.es/cartografia/INSPIRE/spadgcwms.aspx",
        sublayers:     null,        
        visible:       false,
        subLayersVisible: false,   
        legendEnabled: true
      }
    ]
  },
  {
    id:     "grupo-mapas-base",
    title:  "Mapas base",
    tipo:   "GRUPO",
    visible: true,
    visibilityMode: "independent",
    capas: [
      {
        id:            "pnoa",
        title:         "Ortofoto PNOA (IGN)",
        tipo:          "WMS",
        url:           "https://www.ign.es/wms-inspire/pnoa-ma",
        sublayers:     null,        // null → carga todas desde GetCapabilities
        visible:       false,
        subLayersVisible: false,
        legendEnabled: true
      },
    ]
  },
  {
    id:     "grupo-ocupacion-suelo",
    title:  "Ocupación y cobertura del suelo",
    tipo:   "GRUPO",
    visible: true,
    visibilityMode: "independent",
    capas: [      
      {
        id:            "usos-suelo",
        title:         "Usos del suelo (SIOSE)",
        tipo:          "WMS",
        url:           "https://servicios.idee.es/wms-inspire/ocupacion-suelo",
        sublayers:     null,
        visible:       false,
        subLayersVisible: false,
        legendEnabled: true
      }
    ]
  },
  
];
