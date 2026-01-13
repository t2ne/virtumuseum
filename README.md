## Museu Virtual Interativo (A‑Frame) — VirtuMuseum

Projeto para a UC de **Interaction and User Experience (VR/AR)**.

### Objetivo (resumo)
Criar uma experiência **VR “desktop/mobile”** de museu virtual com **visita guiada automática**, **exploração livre**, **hotspots** informativos e **multimédia** (3D + áudio + panorama/vídeo 360).

### Funcionalidades principais
- **Visita guiada** com paragens (movimento + orientação) e texto no painel.
- **Exploração livre** com WASD (desktop) e look-controls (mouse/touch).
- **Hotspots** clicáveis com informação + som/feedback.
- **Menu/overlay** com:
  - Start/Pause/Resume/Stop
  - Teleport para paragens
  - Volume / música ambiente
  - Modo **Panorama 360** e **Vídeo 360**
  - Ajuda (atalhos) + acessibilidade (reduzir movimento)
- **Voz (Web Speech)**: comandos como “iniciar visita”, “pausar”, “retomar”, “parar”, “próxima”, “ajuda”.
- **Áudio sem ficheiros obrigatórios**: música ambiente  

### Use cases (1–2)
1. **Visita guiada**: um utilizador entra no museu e segue uma rota com paragens e informação contextual.
2. **Exploração + descoberta**: um utilizador explora livremente e clica em hotspots para obter detalhes e ouvir narração.

### Hardware/tecnologias testadas (sugestão para o relatório)
- **Desktop**: teclado + rato (WASD + clique; atalhos).
- **Smartphone/tablet**: toque (look-controls) + UI; (opcional) giroscópio via browser.
- **Software**: A‑Frame 1.5; WebAudio/Tone.js; Web Speech API (quando suportado).

### Como correr
Recomendado servir por HTTP (módulos ES e media carregam melhor assim).

```bash
cd /Users/tn/Documents/uni/ieedu/virtumuseum
python3 -m http.server 8000
```

Depois abrir `http://localhost:8000/`.

### Estrutura do projeto
- `index.html`: página principal (A‑Frame scene + UI).
- `src/css/style.css`: estilos do UI.
- `src/js/app.js`: lógica principal (UI + componentes A‑Frame + áudio + voz).
- `src/assets/models/museu.glb`: modelo 3D do museu.
- `src/assets/*`: placeholders para media locais (se quiseres substituir por ficheiros teus).

### Créditos / referências
- A‑Frame examples: `https://aframe.io/aframe/examples/`
- VR heuristics (NN/g): `https://www.nngroup.com/articles/usability-heuristics-virtual-reality/`
