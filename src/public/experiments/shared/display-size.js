// src/public/experiments/shared/display-size.js

/**
 * Creates a display size selector UI component
 * @param {HTMLElement} container - Container element to append selector to
 * @param {function(number)} onChange - Callback when size changes
 * @param {number} defaultSize - Initial size (default 440)
 * @returns {function(): number} Getter for current size
 */
export function createDisplaySizeSelector(container, onChange, defaultSize = 440) {
  const sizes = [440, 520, 600];
  let currentSize = defaultSize;

  const wrapper = document.createElement('div');
  wrapper.className = 'size-selector';

  const label = document.createElement('label');
  label.textContent = 'Display Size:';
  wrapper.appendChild(label);

  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'size-buttons';

  sizes.forEach(size => {
    const btn = document.createElement('button');
    btn.textContent = size + 'px';
    btn.className = size === currentSize ? 'active' : '';
    btn.addEventListener('click', () => {
      currentSize = size;
      buttonsDiv.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(size);
    });
    buttonsDiv.appendChild(btn);
  });

  wrapper.appendChild(buttonsDiv);
  container.appendChild(wrapper);

  return () => currentSize;
}

/**
 * CSS styles for size selector (inject into page)
 */
export const displaySizeStyles = `
  .size-selector {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 0;
  }
  .size-selector label {
    color: #888;
    font-size: 0.9em;
  }
  .size-buttons {
    display: flex;
    gap: 5px;
  }
  .size-buttons button {
    padding: 6px 12px;
    background: #333;
    color: #aaa;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .size-buttons button:hover {
    background: #444;
  }
  .size-buttons button.active {
    background: #00d4ff;
    color: #1a1a2e;
    border-color: #00d4ff;
  }
`;
