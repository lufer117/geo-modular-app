"""
tools/generar_geografia.py
===========================
Lee los shapefiles oficiales del IGN (recintos INSPIRE — municipal,
provincial, autonómico) y genera JSON de datos geográficos según los
niveles y códigos que se pidan por línea de comandos:

    data/municipios.json
    data/provincias.json
    data/ccaa.json

Solo se regenera el archivo del nivel que se pida explícitamente —
si un flag se omite, el JSON existente de ese nivel no se toca.

Uso:
    # Preset de la demo actual (10 municipios ya usados en el prototipo)
    python tools/generar_geografia.py --municipios demo

    # Códigos INE de municipio sueltos
    python tools/generar_geografia.py --municipios 31201,31232

    # CCAA por código INE de comunidad autónoma
    python tools/generar_geografia.py --ccaa 15,17

    # Provincias por código INE de provincia
    python tools/generar_geografia.py --provincias 48

    # Combinado — caso real de prueba de ámbitos territoriales:
    # Navarra + La Rioja como CCAA completas, Bizkaia como provincia sola,
    # más los municipios ya usados en la demo.
    python tools/generar_geografia.py \\
        --municipios demo \\
        --ccaa 15,17 \\
        --provincias 48

Requisitos:
    pip install pyshp shapely

Fuente de los shapefiles:
    Centro de Descargas IGN — "Límites municipales, provinciales y autonómicos"
    https://centrodedescargas.cnig.es/CentroDescargas/limites-municipales-provinciales-autonomicos

    Carpetas esperadas en data/SHP_ETRS89/:
        recintos_municipales_inspire_peninbal_etrs89/
        recintos_provinciales_inspire_peninbal_etrs89/
        recintos_autonomicas_inspire_peninbal_etrs89/

Diseño (ver 3DECISIONS.md, sesión de migración a JSON + generalización CLI):
    - Un único NATCODE (11 dígitos, tras quitar prefijo "ES") codifica
      los tres niveles administrativos en posiciones fijas:
          [0:2]  → "34" (prefijo constante IGN, se descarta)
          [2:4]  → ccaa_code       (presente en los 3 niveles)
          [4:6]  → provincia_code  ("00" en el nivel CCAA)
          [6:11] → codigo_ine      ("00000" en CCAA y provincia)
      Esto reemplaza la tabla manual PROVINCIA_A_CCAA que existía en la
      versión anterior del script — una sola fuente de verdad (el propio
      IGN), sin tabla editorial que pueda desincronizarse.
    - Los JSON generados NO incluyen ruta de logo. La resolución de logo
      de municipio se decidió en runtime (frontend, ui/municipioSelector.js,
      fallback en cascada de extensión) para desacoplar geometría de
      presentación — ver 4STATUS.md, "Resolución de logo de municipio".
    - CCAA y provincia son niveles administrativos distintos: "Bizkaia"
      es provincia, no CCAA (la CCAA correspondiente es País Vasco/Euskadi,
      código 16). El script no intenta adivinar equivalencias — cada
      código pasado por --ccaa se busca tal cual en el nivel autonómico,
      y cada código de --provincias en el nivel provincial.
"""

import argparse
import json
import sys
from pathlib import Path

import shapefile                          # pyshp
from shapely.geometry import shape, MultiPolygon, Polygon
from shapely.ops import unary_union

# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
DATA_DIR   = SCRIPT_DIR.parent / "data"
SHP_DIR    = DATA_DIR / "SHP_ETRS89"

SHP_MUNICIPAL   = SHP_DIR / "recintos_municipales_inspire_peninbal_etrs89"   / "recintos_municipales_inspire_peninbal_etrs89.shp"
SHP_PROVINCIAL  = SHP_DIR / "recintos_provinciales_inspire_peninbal_etrs89"  / "recintos_provinciales_inspire_peninbal_etrs89.shp"
SHP_AUTONOMICO  = SHP_DIR / "recintos_autonomicas_inspire_peninbal_etrs89"   / "recintos_autonomicas_inspire_peninbal_etrs89.shp"

OUT_MUNICIPIOS  = DATA_DIR / "municipios.json"
OUT_PROVINCIAS  = DATA_DIR / "provincias.json"
OUT_CCAA        = DATA_DIR / "ccaa.json"

TOLERANCE = 0.001   # ~100 m. Reduce vértices manteniendo forma reconocible.

# ---------------------------------------------------------------------------
# Preset "demo" — los municipios ya usados en el prototipo actual.
# Se mantiene como preset con nombre (no como default oculto) para que
# quede explícito en el comando qué se está generando y por qué.
# ---------------------------------------------------------------------------

PRESET_MUNICIPIOS_DEMO = [
    "48020",   # Bilbao
    "20069",   # Donostia/San Sebastián
    "01059",   # Vitoria-Gasteiz
    "48013",   # Barakaldo
    "48044",   # Getxo
    "31201",   # Pamplona/Iruña
    "31232",   # Tudela
    "31084",   # Estella/Lizarra
    "26089",   # Logroño
    "09059",   # Burgos
]

# ---------------------------------------------------------------------------
# NATCODE — extracción por posición fija (ver docstring del módulo)
# ---------------------------------------------------------------------------

def _limpiar_natcode(valor_raw: str) -> str:
    """Quita espacios y el prefijo 'ES' si existe. Devuelve string de 11 dígitos."""
    v = str(valor_raw).strip()
    if v.startswith("ES"):
        v = v[2:]
    return v


def ccaa_code_de(natcode: str) -> str:
    return _limpiar_natcode(natcode)[2:4]


def provincia_code_de(natcode: str) -> str:
    return _limpiar_natcode(natcode)[4:6]


def codigo_ine_de(natcode: str) -> str:
    return _limpiar_natcode(natcode)[6:11]


# ---------------------------------------------------------------------------
# Lectura genérica de shapefile
# ---------------------------------------------------------------------------

def leer_shp(shp_path: Path, campo_codigo_objetivo, codigos_objetivo: set) -> dict:
    """
    Lee un shapefile IGN y devuelve solo los registros cuyo código
    (calculado con `campo_codigo_objetivo`, una de las funciones
    ccaa_code_de / provincia_code_de / codigo_ine_de) está en
    `codigos_objetivo`.

    Devuelve: { codigo: { "natcode": str, "nombre": str, "geom": geojson } }
    """
    if not shp_path.exists():
        print(f"\nERROR: Shapefile no encontrado en:\n  {shp_path}")
        sys.exit(1)

    print(f"Leyendo shapefile: {shp_path.name}")
    sf     = shapefile.Reader(str(shp_path), encoding="utf-8")
    fields = [f[0] for f in sf.fields[1:]]

    if "NATCODE" not in fields or "NAMEUNIT" not in fields:
        print(f"  ERROR: Campos esperados no encontrados. Campos disponibles: {fields}")
        sys.exit(1)

    idx_natcode = fields.index("NATCODE")
    idx_nombre  = fields.index("NAMEUNIT")

    resultados   = {}
    total_leidos = 0

    for sr in sf.iterShapeRecords():
        total_leidos += 1
        natcode_raw = str(sr.record[idx_natcode]).strip()
        codigo = campo_codigo_objetivo(natcode_raw)

        if codigo not in codigos_objetivo:
            continue

        nombre = str(sr.record[idx_nombre]).strip()
        geom   = sr.shape.__geo_interface__

        resultados[codigo] = {
            "natcode": _limpiar_natcode(natcode_raw),
            "nombre": nombre,
            "geom": geom,
        }
        print(f"  Encontrado: {codigo} — {nombre}")

    print(f"  Registros leídos: {total_leidos} | Coincidencias: {len(resultados)}")
    return resultados


# ---------------------------------------------------------------------------
# Geometría (agnóstica a nivel — misma función para municipio/provincia/ccaa)
# ---------------------------------------------------------------------------

def simplify_to_rings(geom_json: dict, tolerance: float) -> list:
    """
    Simplifica la geometría y devuelve rings en formato ArcGIS:
        [[[lon, lat], ...], ...]

    MultiPolygon → unary_union antes de simplificar para evitar
    rings de enclaves que complican la máscara donut de mapManager.
    preserve_topology=True evita auto-intersecciones.
    """
    geom = shape(geom_json)

    if isinstance(geom, MultiPolygon):
        geom = unary_union(geom)

    simplified = geom.simplify(tolerance, preserve_topology=True)

    if simplified.is_empty:
        simplified = geom   # fallback sin simplificación

    def poly_to_rings(poly: Polygon) -> list:
        rings = []
        rings.append([[round(x, 6), round(y, 6)] for x, y in poly.exterior.coords])
        for interior in poly.interiors:
            rings.append([[round(x, 6), round(y, 6)] for x, y in interior.coords])
        return rings

    if isinstance(simplified, Polygon):
        return poly_to_rings(simplified)
    elif isinstance(simplified, MultiPolygon):
        rings = []
        for part in simplified.geoms:
            rings.extend(poly_to_rings(part))
        return rings
    else:
        b = simplified.bounds
        return [[[b[0], b[1]], [b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]]


def compute_bbox(rings: list) -> list:
    """[xmin, ymin, xmax, ymax] calculado desde los rings del polígono."""
    all_coords = [c for ring in rings for c in ring]
    xs = [c[0] for c in all_coords]
    ys = [c[1] for c in all_coords]
    return [round(min(xs), 6), round(min(ys), 6),
            round(max(xs), 6), round(max(ys), 6)]


# ---------------------------------------------------------------------------
# Generadores por nivel — comparten leer_shp / simplify_to_rings / compute_bbox
# ---------------------------------------------------------------------------

def generar_municipios(codigos: list) -> list:
    print("\n--- Nivel: MUNICIPIOS ---")
    datos = leer_shp(SHP_MUNICIPAL, codigo_ine_de, set(codigos))

    entries = []
    for codigo_ine in codigos:
        if codigo_ine not in datos:
            print(f"  ✗  {codigo_ine} — no encontrado")
            continue

        d = datos[codigo_ine]
        rings = simplify_to_rings(d["geom"], TOLERANCE)
        bbox  = compute_bbox(rings)

        entries.append({
            "codigo_ine": codigo_ine,
            "nombre": d["nombre"],
            "provincia_code": provincia_code_de(d["natcode"]),
            "ccaa_code": ccaa_code_de(d["natcode"]),
            "bbox": bbox,
            "polygon": {
                "rings": rings,
                "spatialReference": {"wkid": 4326}
            }
        })
        print(f"  ✓  {d['nombre']} ({codigo_ine}) | prov={provincia_code_de(d['natcode'])} "
              f"ccaa={ccaa_code_de(d['natcode'])} | {sum(len(r) for r in rings)} vértices")

    return entries


def generar_provincias(codigos: list) -> list:
    print("\n--- Nivel: PROVINCIAS ---")
    datos = leer_shp(SHP_PROVINCIAL, provincia_code_de, set(codigos))

    entries = []
    for codigo in codigos:
        if codigo not in datos:
            print(f"  ✗  {codigo} — no encontrado")
            continue

        d = datos[codigo]
        rings = simplify_to_rings(d["geom"], TOLERANCE)
        bbox  = compute_bbox(rings)

        entries.append({
            "tipo": "provincia",
            "provincia_code": codigo,
            "ccaa_code": ccaa_code_de(d["natcode"]),
            "nombre": d["nombre"],
            "bbox": bbox,
            "polygon": {
                "rings": rings,
                "spatialReference": {"wkid": 4326}
            }
        })
        print(f"  ✓  {d['nombre']} ({codigo}) | ccaa={ccaa_code_de(d['natcode'])} "
              f"| {sum(len(r) for r in rings)} vértices")

    return entries


def generar_ccaa(codigos: list) -> list:
    print("\n--- Nivel: CCAA ---")
    datos = leer_shp(SHP_AUTONOMICO, ccaa_code_de, set(codigos))

    entries = []
    for codigo in codigos:
        if codigo not in datos:
            print(f"  ✗  {codigo} — no encontrado")
            continue

        d = datos[codigo]
        rings = simplify_to_rings(d["geom"], TOLERANCE)
        bbox  = compute_bbox(rings)

        entries.append({
            "tipo": "ccaa",
            "ccaa_code": codigo,
            "nombre": d["nombre"],
            "bbox": bbox,
            "polygon": {
                "rings": rings,
                "spatialReference": {"wkid": 4326}
            }
        })
        print(f"  ✓  {d['nombre']} ({codigo}) | {sum(len(r) for r in rings)} vértices")

    return entries


# ---------------------------------------------------------------------------
# Escritura JSON
# ---------------------------------------------------------------------------

def escribir_json(entries: list, output_path: Path, descripcion: str):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"✓  {len(entries)} {descripcion} escritos → {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parsear_lista_codigos(valor: str) -> list:
    """'15,17,31' → ['15','17','31']. Espacios y vacíos se ignoran."""
    return [c.strip() for c in valor.split(",") if c.strip()]


def main():
    parser = argparse.ArgumentParser(
        description="Genera municipios.json / provincias.json / ccaa.json desde shapefiles IGN.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--municipios",
        type=str,
        default=None,
        help="Códigos INE de municipio separados por coma, o la palabra 'demo' "
             "para usar el preset de municipios ya usados en el prototipo."
    )
    parser.add_argument(
        "--provincias",
        type=str,
        default=None,
        help="Códigos INE de provincia separados por coma (ej. 48 para Bizkaia)."
    )
    parser.add_argument(
        "--ccaa",
        type=str,
        default=None,
        help="Códigos INE de comunidad autónoma separados por coma (ej. 15,17)."
    )

    args = parser.parse_args()

    if not args.municipios and not args.provincias and not args.ccaa:
        parser.error(
            "Debes indicar al menos un nivel a generar: --municipios, --provincias o --ccaa.\n"
            "Ejemplo: python tools/generar_geografia.py --municipios demo --ccaa 15,17 --provincias 48"
        )

    print("Generando geografía\n")

    resultado_ok = True

    if args.municipios:
        codigos = PRESET_MUNICIPIOS_DEMO if args.municipios.strip().lower() == "demo" \
            else _parsear_lista_codigos(args.municipios)
        entries = generar_municipios(codigos)
        if len(entries) < len(codigos):
            resultado_ok = False
        escribir_json(entries, OUT_MUNICIPIOS, "municipios")

    if args.provincias:
        codigos = _parsear_lista_codigos(args.provincias)
        entries = generar_provincias(codigos)
        if len(entries) < len(codigos):
            resultado_ok = False
        escribir_json(entries, OUT_PROVINCIAS, "provincias")

    if args.ccaa:
        codigos = _parsear_lista_codigos(args.ccaa)
        entries = generar_ccaa(codigos)
        if len(entries) < len(codigos):
            resultado_ok = False
        escribir_json(entries, OUT_CCAA, "CCAA")

    print()
    return 0 if resultado_ok else 1


if __name__ == "__main__":
    sys.exit(main())