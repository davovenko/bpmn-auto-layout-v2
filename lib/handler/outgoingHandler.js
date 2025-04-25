import { connectElements } from '../utils/layoutUtil.js';
import { is } from '../di/DiUtil.js';
import { findElementInTree } from '../utils/elementUtils.js';


export default {
  'addToGrid': ({ element, grid, visited, stack }) => {
    let nextElements = [];

    // Handle outgoing paths
    const outgoing = (element.outgoing || [])
      .map(out => out.targetRef)
      .filter(el => el);

    let previousElement = null;

    // Для шлюзов нужна особая обработка, чтобы параллельные потоки шли в отдельных строках
    const isGateway = is(element, 'bpmn:Gateway');
    
    outgoing.forEach((nextElement, index, arr) => {
      if (visited.has(nextElement)) {
        return;
      }

      // Prevents revisiting future incoming elements and ensures proper traversal without early exit.
      if ((previousElement || stack.length > 0) && isFutureIncoming(nextElement, visited) && !checkForLoop(nextElement, visited)) {
        return;
      }

      // Для горизонтальной компоновки
      if (index === 0 || !isGateway) {
        // Первый элемент после gateway или обычные элементы идут справа
        grid.addAfter(element, nextElement);
      } else {
        // Другие элементы после gateway идут снизу (параллельные потоки)
        grid.addBelow(element, nextElement);
      }

      // Is self-looping
      if (nextElement !== element) {
        previousElement = nextElement;
      }

      nextElements.unshift(nextElement);
      visited.add(nextElement);
    });

    // Шлюзы обрабатываются первыми для правильной компоновки
    if (outgoing.length > 1) {
      nextElements = sortByType(nextElements, 'bpmn:Gateway');
    }
    
    return nextElements;
  },

  'createConnectionDi': ({ element, row, col, layoutGrid, diFactory, verticalOffset = 0 }) => {
    const outgoing = element.outgoing || [];

    return outgoing.map(out => {
      const target = out.targetRef;
      
      // При создании соединений используется функция connectElements
      // которая учитывает положение элементов и создает горизонтальные соединения
      const waypoints = connectElements(element, target, layoutGrid);

      const connectionDi = diFactory.createDiEdge(out, waypoints, {
        id: out.id + '_di'
      });

      return connectionDi;
    });
  }
};


// helpers /////

function sortByType(arr, type) {
  const nonMatching = arr.filter(item => !is(item,type));
  const matching = arr.filter(item => is(item,type));

  return [ ...matching, ...nonMatching ];

}

function checkForLoop(element, visited) {
  for (const incomingElement of element.incoming) {
    if (!visited.has(incomingElement.sourceRef)) {
      return findElementInTree(element, incomingElement.sourceRef);
    }
  }
}


function isFutureIncoming(element, visited) {
  if (element.incoming.length > 1) {
    for (const incomingElement of element.incoming) {
      if (!visited.has(incomingElement.sourceRef)) {
        return true;
      }
    }
  }
  return false;
}

function isNextElementTasks(elements) {
  return elements.every(element => is(element, 'bpmn:Task'));
}