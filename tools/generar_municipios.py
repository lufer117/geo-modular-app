"""
tools/generar_municipios.py
===========================
Lee el shapefile oficial del IGN (recintos municipales INSPIRE)
y genera config/municipios.js con los municipios configurados.

Uso:
    python tools/generar_municipios.py

Requisitos:
    pip install pyshp shapely

Fuente del shapefile:
    Centro de Descargas IGN — Líneas Límite Municipales
    Archivo: SHP_ETRS89/recintos_municipales_inspire_peninbal_etrs89/
             recintos_municipales_inspire_peninbal_etrs89.shp
    Colocar la carpeta completa en: data/SHP_ETRS89/
"""

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
SHP_PATH   = DATA_DIR / "SHP_ETRS89" / "recintos_municipales_inspire_peninbal_etrs89" / "recintos_municipales_inspire_peninbal_etrs89.shp"
OUTPUT_PATH = SCRIPT_DIR.parent / "config" / "municipios.js"

TOLERANCE = 0.001   # ~100 m. Reduce vértices manteniendo forma reconocible.

# ---------------------------------------------------------------------------
# Lookup CCAA — fuente: INE (tabla CODAUTO / CPRO oficial)
# Clave: codigo_provincia (2 dígitos string)
# Valor: ccaa_code (2 dígitos string)
# Solo necesitamos un diccionario de 19 CCAA, no cambia nunca.
# ---------------------------------------------------------------------------

PROVINCIA_A_CCAA = {
    # 01 Andalucía
    "04": "01", "11": "01", "14": "01", "18": "01",
    "21": "01", "23": "01", "29": "01", "41": "01",
    # 02 Aragón
    "22": "02", "44": "02", "50": "02",
    # 03 Asturias
    "33": "03",
    # 04 Illes Balears
    "07": "04",
    # 05 Canarias
    "35": "05", "38": "05",
    # 06 Cantabria
    "39": "06",
    # 07 Castilla y León
    "05": "07", "09": "07", "24": "07", "34": "07",
    "37": "07", "40": "07", "42": "07", "47": "07", "49": "07",
    # 08 Castilla-La Mancha
    "02": "08", "13": "08", "16": "08", "19": "08", "45": "08",
    # 09 Cataluña
    "08": "09", "17": "09", "25": "09", "43": "09",
    # 10 Comunitat Valenciana
    "03": "10", "12": "10", "46": "10",
    # 11 Extremadura
    "06": "11", "10": "11",
    # 12 Galicia
    "15": "12", "27": "12", "32": "12", "36": "12",
    # 13 Madrid
    "28": "13",
    # 14 Murcia
    "30": "14",
    # 15 Navarra
    "31": "15",
    # 16 País Vasco
    "01": "16", "48": "16", "20": "16",
    # 17 La Rioja
    "26": "17",
    # 18 Ceuta
    "51": "18",
    # 19 Melilla
    "52": "19",
}

# ---------------------------------------------------------------------------
# Municipios a generar
# Solo la lista de códigos INE (5 dígitos).
# nombre, provincia_code y ccaa_code se extraen/calculan automáticamente.
# ---------------------------------------------------------------------------

MUNICIPIOS_INE = [
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
# Leer shapefile
# ---------------------------------------------------------------------------

def leer_shp(shp_path: Path) -> dict:
    """
    Lee el shapefile del IGN y devuelve un diccionario:
        { codigo_ine: { "geom": geojson_geometry, "nombre": str } }

    NATCODE en el shapefile IGN INSPIRE tiene formato 11 dígitos:
        "34153131201"  →  últimos 5 = "31201" (código INE municipal)
    NAMEUNIT contiene el nombre oficial del municipio.
    """
    print(f"Leyendo shapefile: {shp_path}")

    sf     = shapefile.Reader(str(shp_path), encoding="utf-8")
    fields = [f[0] for f in sf.fields[1:]]
    print(f"  Campos disponibles: {fields}")

    # Detectar campo con código INE
    if "NATCODE" in fields:
        campo_codigo = "NATCODE"
    elif "CODIGOINE" in fields:
        campo_codigo = "CODIGOINE"
    elif "CODINE" in fields:
        campo_codigo = "CODINE"
    else:
        print(f"  ERROR: No se encontró campo INE. Campos: {fields}")
        sys.exit(1)

    if "NAMEUNIT" not in fields:
        print(f"  ERROR: No se encontró campo NAMEUNIT. Campos: {fields}")
        sys.exit(1)

    print(f"  Campo código: '{campo_codigo}' | Campo nombre: 'NAMEUNIT'")

    idx_codigo = fields.index(campo_codigo)
    idx_nombre = fields.index("NAMEUNIT")

    codigos_objetivo = set(MUNICIPIOS_INE)
    resultados       = {}
    total_leidos     = 0

    for sr in sf.iterShapeRecords():
        total_leidos += 1
        valor_raw = str(sr.record[idx_codigo]).strip()

        # El NATCODE IGN tiene 11 dígitos; el código INE son los últimos 5.
        # Para campos CODIGOINE o CODINE el valor ya es el código INE directo.
        if campo_codigo == "NATCODE":
            # Eliminar prefijo "ES" si existe, luego tomar últimos 5 dígitos
            valor_raw = valor_raw.replace("ES", "", 1)
            codigo_ine = valor_raw[-5:]
        else:
            codigo_ine = valor_raw[-5:]   # por consistencia, siempre últimos 5

        if codigo_ine not in codigos_objetivo:
            continue

        nombre = str(sr.record[idx_nombre]).strip()
        geom   = sr.shape.__geo_interface__

        resultados[codigo_ine] = {"geom": geom, "nombre": nombre}
        print(f"  Encontrado: {codigo_ine} — {nombre}")

    print(f"  Registros leídos: {total_leidos} | Municipios encontrados: {len(resultados)}")
    return resultados


# ---------------------------------------------------------------------------
# Geometría
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
# Serialización JS
# ---------------------------------------------------------------------------

def to_js_entry(codigo_ine: str, nombre: str, provincia_code: str,
                ccaa_code: str, rings: list, bbox: list) -> str:
    rings_str  = json.dumps(rings, separators=(",", ":"))
    bbox_str   = json.dumps(bbox)
    n_vertices = sum(len(r) for r in rings)

    # Lógica para la extensión del logo
    # Puedes usar .png por defecto o mapearlo según el código INE
    extensiones = {"48020": "webp", "31201": "jpg"} # Ejemplo de excepciones
    ext = extensiones.get(codigo_ine, "png")
    logo_path = f"../assets/logos/{codigo_ine}.{ext}"

    return (
        "  {\n"
        f"    codigo_ine:     \"{codigo_ine}\",\n"
        f"    nombre:         \"{nombre}\",\n"
        f"    logo:           \"{logo_path}\",\n"
        f"    provincia_code: \"{provincia_code}\",\n"
        f"    ccaa_code:      \"{ccaa_code}\",\n"
        f"    bbox: {bbox_str},\n"
        f"    polygon: {{\n"
        f"      rings: {rings_str},\n"
        f"      spatialReference: {{ wkid: 4326 }}\n"
        f"    }}  // {n_vertices} vértices (tolerance={TOLERANCE})\n"
        "  }"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not SHP_PATH.exists():
        print(f"\nERROR: Shapefile no encontrado en:\n  {SHP_PATH}")
        print("\nColoca los archivos .shp .shx .dbf .prj .cpg en esa carpeta.")
        print("Fuente: Centro de Descargas IGN — Líneas Límite Municipales")
        sys.exit(1)

    print(f"\nGenerando config/municipios.js — {len(MUNICIPIOS_INE)} municipios\n")

    # 1. Leer shapefile → { codigo_ine: { geom, nombre } }
    datos_shp = leer_shp(SHP_PATH)

    # 2. Procesar cada municipio
    entries = []
    failed  = []

    print()
    for codigo_ine in MUNICIPIOS_INE:

        if codigo_ine not in datos_shp:
            print(f"  ✗  {codigo_ine} — no encontrado en el shapefile")
            failed.append(codigo_ine)
            continue

        nombre = datos_shp[codigo_ine]["nombre"]

        # provincia_code: primeros 2 dígitos del código INE
        # Fundamento INE: el código municipal es PPMMM (PP=provincia, MMM=municipio)
        provincia_code = codigo_ine[:2]

        # ccaa_code: lookup desde tabla INE provincia→CCAA
        ccaa_code = PROVINCIA_A_CCAA.get(provincia_code)
        if not ccaa_code:
            print(f"  ✗  {codigo_ine} ({nombre}) — provincia '{provincia_code}' no encontrada en lookup CCAA")
            failed.append(codigo_ine)
            continue

        # Geometría
        rings = simplify_to_rings(datos_shp[codigo_ine]["geom"], TOLERANCE)
        bbox  = compute_bbox(rings)
        n     = sum(len(r) for r in rings)

        print(f"  ✓  {nombre} ({codigo_ine}) | prov={provincia_code} ccaa={ccaa_code} | {n} vértices | bbox={bbox}")
        entries.append(to_js_entry(codigo_ine, nombre, provincia_code, ccaa_code, rings, bbox))

    # 3. Escribir municipios.js
    header = (
        "// config/municipios.js\n"
        "// Generado automáticamente por tools/generar_municipios.py\n"
        "// Fuente geometría: IGN — Recintos Municipales INSPIRE (SHP_ETRS89, peninbal)\n"
        "// Fuente códigos:   INE — Relación CODAUTO / CPRO / CMUN\n"
        f"// Simplificación:  tolerance={TOLERANCE}° (~100 m), preserve_topology=True\n"
        "//\n"
        "// NO editar manualmente. Regenerar con el script si cambian los municipios.\n"
        "// Para añadir municipios: agregar el codigo_ine a MUNICIPIOS_INE en el script.\n\n"
    )

    body = (
        "export const MUNICIPIOS = [\n"
        + ",\n".join(entries)
        + "\n];\n"
    )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(header + body, encoding="utf-8")

    # 4. Resumen
    print(f"\n{'='*60}")
    print(f"✓  {len(entries)} municipios escritos → {OUTPUT_PATH}")
    if failed:
        print(f"✗  Fallidos ({len(failed)}): {', '.join(failed)}")
    print(f"{'='*60}\n")

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())