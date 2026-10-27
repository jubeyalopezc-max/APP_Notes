# NotesPro

App de notas para la universidad, hecha para tablets Android con lápiz óptico.

- Materias con colores y notas por materia
- Escritura con lápiz sensible a la presión; la palma no raya
- Lápiz mágico: convierte trazos en líneas, flechas, círculos, óvalos, triángulos, rectángulos, rombos y polígonos
  (o mantén el lápiz quieto al final de un trazo con el lápiz normal)
- Resaltador, borrador, lazo para seleccionar y mover, texto con teclado
- Insertar imágenes desde la galería o la cámara
- Hojas rayadas, cuadriculadas, de puntos o en blanco; varias páginas por nota
- Deshacer con dos dedos; todo se guarda en la tablet, sin internet

## Descargar el APK

Cada cambio en `main` compila la app automáticamente. El APK queda en la sección **Releases** del repositorio.

## Estructura

- `www/` — la app (HTML, CSS y JavaScript)
- `android/` — proyecto Android generado con Capacitor
- `.github/workflows/build-apk.yml` — compilación y publicación del APK
