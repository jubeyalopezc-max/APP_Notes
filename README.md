# NotesPro

App de notas para la universidad, hecha para tablets Android con lápiz óptico.

- Materias con colores y notas por materia
- Escritura con lápiz sensible a la presión; la palma no raya
- Lápiz mágico: convierte trazos en líneas, flechas, círculos, óvalos, triángulos, rectángulos, rombos y polígonos
  (o mantén el lápiz quieto al final de un trazo con el lápiz normal)
- Resaltador, borrador, lazo para seleccionar y mover, texto con teclado
- Insertar imágenes desde la galería o la cámara
- Dos formatos: **hojas** (páginas una debajo de otra) o **lienzo libre** (sin bordes, hacia cualquier lado)
- Fondos rayado, cuadriculado, de puntos o en blanco
- **Ver todo**: en hojas muestra todas las páginas en cuadrícula; en el lienzo aleja la vista hasta que se vea todo lo dibujado
- **Mapa** de la nota en una esquina: muestra dónde estás y lleva a cualquier parte con un toque
- Zoom con pellizco o botones, que permite alejarse hasta ver la nota completa
- Deshacer con dos dedos; todo se guarda en la tablet, sin internet

## Descargar el APK

Cada cambio en `main` compila la app automáticamente. El APK queda en la sección **Releases** del repositorio.

## Estructura

- `www/` — la app (HTML, CSS y JavaScript)
- `android/` — proyecto Android generado con Capacitor
- `.github/workflows/build-apk.yml` — compilación y publicación del APK
