import BPMNModdle from 'bpmn-moddle';
import { isBoundaryEvent, isConnection } from './utils/elementUtils.js';
import { Grid } from './Grid.js';
import { DiFactory } from './di/DiFactory.js';
import { is, getDefaultSize } from './di/DiUtil.js';
import { handlers } from './handler/index.js';
import { isFunction } from 'min-dash';

export class Layouter {
  constructor() {
    this.moddle = new BPMNModdle();
    this.diFactory = new DiFactory(this.moddle);
    this._handlers = handlers;
  }

  handle(operation, options) {
    return this._handlers
      .filter(handler => isFunction(handler[operation]))
      .map(handler => handler[operation](options));

  }

  async layoutProcess(xml) {
    const { rootElement } = await this.moddle.fromXML(xml);

    this.diagram = rootElement;
    this.cleanDi();
    
    // Проверка наличия Collaboration (несколько пулов)
    const collaboration = this.diagram.get('rootElements').find(el => el.$type === 'bpmn:Collaboration');
    
    if (collaboration) {
      // Создаем диаграмму и плоскость для коллаборации
      const diagram = this.diFactory.createDiDiagram({
        id: 'BPMNDiagram_' + collaboration.id
      });
      
      const plane = this.diFactory.createDiPlane({
        id: 'BPMNPlane_' + collaboration.id,
        bpmnElement: collaboration
      });
      
      diagram.plane = plane;
      this.diagram.diagrams = [diagram];
      
      this.layoutCollaboration(collaboration, plane);
    } else {
      // Стандартный случай с одним процессом
      const process = this.getProcess();
      if (process) {
        const diagram = this.diFactory.createDiDiagram({
          id: 'BPMNDiagram_' + process.id
        });
        
        const plane = this.diFactory.createDiPlane({
          id: 'BPMNPlane_' + process.id,
          bpmnElement: process
        });
        
        diagram.plane = plane;
        this.diagram.diagrams = [diagram];
        
        this.layoutSingleProcess(process, plane);
      }
    }

    return (await this.moddle.toXML(this.diagram, { format: true })).xml;
  }

  // Метод для обработки коллаборации с пулами
  layoutCollaboration(collaboration, plane) {
    const planeElement = plane.get('planeElement') || [];
    plane.set('planeElement', planeElement);
    
    const participants = collaboration.participants || [];
    let poolY = 50;
    
    // Обрабатываем каждый пул
    participants.forEach(participant => {
      if (!participant.processRef) return;
      
      const process = participant.processRef;
      
      // Создаем горизонтальный пул
      const poolWidth = 2000; // Широкий пул для горизонтальной ориентации
      const poolHeight = this.calculatePoolHeight(process);
      
      const poolBounds = {
        x: 50,
        y: poolY,
        width: poolWidth,
        height: poolHeight
      };
      
      const poolShape = this.diFactory.createDiShape(participant, poolBounds, {
        id: participant.id + '_di',
        isHorizontal: true // Обязательно горизонтальная ориентация
      });
      
      planeElement.push(poolShape);
      
      // Обрабатываем дорожки и элементы процесса
      this.layoutProcessContent(process, poolBounds, planeElement);
      
      // Увеличиваем Y для следующего пула
      poolY += poolHeight + 100;
    });
  }
  
  // Метод для обработки одиночного процесса
  layoutSingleProcess(process, plane) {
    const planeElement = plane.get('planeElement') || [];
    plane.set('planeElement', planeElement);
    
    // Размеры для процесса
    const processBounds = {
      x: 50,
      y: 50,
      width: 2000,
      height: 800
    };
    
    // Обрабатываем содержимое процесса
    this.layoutProcessContent(process, processBounds, planeElement);
  }
  
  // Метод для обработки содержимого процесса (дорожки и элементы)
  layoutProcessContent(process, bounds, planeElement) {
    // Обрабатываем дорожки, если они есть
    if (process.laneSets && process.laneSets.length > 0) {
      const lanes = process.laneSets.flatMap(laneSet => laneSet.lanes || []);
      
      if (lanes.length > 0) {
        this.layoutLanes(lanes, bounds, planeElement);
      }
    }
    
    // Получаем элементы потока
    const flowElements = process.flowElements || [];
    
    // Разделяем на узлы и потоки
    const nodes = flowElements.filter(el => !is(el, 'bpmn:SequenceFlow'));
    const flows = flowElements.filter(el => is(el, 'bpmn:SequenceFlow'));
    
    // Создаем карту соответствия элементов дорожкам
    const laneMap = this.createLaneMap(process);
    
    // Горизонтальное размещение элементов
    this.layoutNodesHorizontally(nodes, flows, bounds, laneMap, planeElement);
    
    // Создаем соединения
    this.createConnections(flows, planeElement);
  }
  
  // Метод для размещения дорожек
  layoutLanes(lanes, bounds, planeElement) {
    const laneHeight = bounds.height / lanes.length;
    
    lanes.forEach((lane, index) => {
      const laneBounds = {
        x: bounds.x,
        y: bounds.y + (index * laneHeight),
        width: bounds.width,
        height: laneHeight
      };
      
      const laneShape = this.diFactory.createDiShape(lane, laneBounds, {
        id: lane.id + '_di',
        isHorizontal: true // Обязательно горизонтальная ориентация
      });
      
      planeElement.push(laneShape);
    });
  }
  
  // Метод для создания карты соответствия элементов дорожкам
  createLaneMap(process) {
    const laneMap = new Map();
    
    if (!process.laneSets) return laneMap;
    
    process.laneSets.forEach(laneSet => {
      (laneSet.lanes || []).forEach(lane => {
        (lane.flowNodeRefs || []).forEach(nodeRef => {
          laneMap.set(nodeRef.id, lane);
        });
      });
    });
    
    return laneMap;
  }
  
  // Метод для размещения узлов горизонтально
  layoutNodesHorizontally(nodes, flows, bounds, laneMap, planeElement) {
    // Создаем карту связей между элементами
    const connectionMap = this.createConnectionMap(flows);
    
    // Выделяем начальные элементы (без входящих связей)
    const startNodes = nodes.filter(node => 
      !connectionMap.incoming.has(node.id) || connectionMap.incoming.get(node.id).length === 0
    );
    
    // Строим уровни элементов для горизонтальной компоновки
    const levels = this.buildHorizontalLevels(nodes, connectionMap, startNodes);
    
    // Размещаем элементы по уровням с учетом дорожек
    this.placeElementsInLevels(levels, bounds, laneMap, planeElement);
  }
  
  // Метод для создания карты связей между элементами
  createConnectionMap(flows) {
    const connections = {
      incoming: new Map(),
      outgoing: new Map()
    };
    
    flows.forEach(flow => {
      if (flow.sourceRef && flow.targetRef) {
        // Добавляем связь в исходящие для источника
        if (!connections.outgoing.has(flow.sourceRef.id)) {
          connections.outgoing.set(flow.sourceRef.id, []);
        }
        connections.outgoing.get(flow.sourceRef.id).push(flow.targetRef);
        
        // Добавляем связь во входящие для цели
        if (!connections.incoming.has(flow.targetRef.id)) {
          connections.incoming.set(flow.targetRef.id, []);
        }
        connections.incoming.get(flow.targetRef.id).push(flow.sourceRef);
      }
    });
    
    return connections;
  }
  
  // Метод для построения уровней элементов
  buildHorizontalLevels(nodes, connectionMap, startNodes) {
    const levels = [];
    const processed = new Set();
    
    // Добавляем стартовые элементы в первый уровень
    levels.push(startNodes);
    startNodes.forEach(node => processed.add(node.id));
    
    // Строим уровни, пока не обработаем все элементы
    while (processed.size < nodes.length) {
      const nextLevel = [];
      const currentLevel = levels[levels.length - 1];
      
      // Для каждого элемента текущего уровня находим следующие элементы
      currentLevel.forEach(node => {
        const nextNodes = connectionMap.outgoing.get(node.id) || [];
        
        nextNodes.forEach(nextNode => {
          // Пропускаем уже обработанные элементы
          if (processed.has(nextNode.id)) return;
          
          // Проверяем, что все входящие элементы уже обработаны
          const incomingNodes = connectionMap.incoming.get(nextNode.id) || [];
          const allIncomingProcessed = incomingNodes.every(incoming => 
            processed.has(incoming.id)
          );
          
          // Если все входящие обработаны, добавляем элемент в следующий уровень
          if (allIncomingProcessed && !processed.has(nextNode.id)) {
            nextLevel.push(nextNode);
            processed.add(nextNode.id);
          }
        });
      });
      
      // Если не удалось найти новые элементы, но остались необработанные
      if (nextLevel.length === 0 && processed.size < nodes.length) {
        // Добавляем первый необработанный элемент
        const unprocessedNode = nodes.find(node => !processed.has(node.id));
        if (unprocessedNode) {
          nextLevel.push(unprocessedNode);
          processed.add(unprocessedNode.id);
        }
      }
      
      // Добавляем уровень, если там есть элементы
      if (nextLevel.length > 0) {
        levels.push(nextLevel);
      }
    }
    
    return levels;
  }
  
  // Метод для размещения элементов по уровням
  placeElementsInLevels(levels, bounds, laneMap, planeElement) {
    // Расстояния между элементами
    const horizontalSpacing = 200; // Между уровнями
    const verticalSpacing = 100;   // Между элементами в уровне
    
    // Начальная X-координата
    let levelX = bounds.x + 100;
    
    // Для каждого уровня
    levels.forEach(level => {
      // Группируем элементы по дорожкам
      const nodesByLane = new Map();
      
      // Распределяем элементы по дорожкам
      level.forEach(node => {
        const laneId = laneMap.has(node.id) ? laneMap.get(node.id).id : null;
        
        if (!nodesByLane.has(laneId)) {
          nodesByLane.set(laneId, []);
        }
        
        nodesByLane.get(laneId).push(node);
      });
      
      // Размещаем элементы в каждой дорожке
      let maxWidth = 0;
      
      nodesByLane.forEach((nodesInLane, laneId) => {
        const lane = laneId ? laneMap.get(nodesInLane[0].id) : null;
        let laneY = bounds.y + 50; // По умолчанию, если нет дорожки
        
        if (lane) {
          // Находим границы дорожки
          const allLanes = Array.from(new Set(Array.from(laneMap.values())));
          const laneIndex = allLanes.indexOf(lane);
          const laneHeight = bounds.height / allLanes.length;
          
          // Центр дорожки
          laneY = bounds.y + (laneIndex * laneHeight) + 50;
        }
        
        // Размещаем элементы в дорожке
        nodesInLane.forEach((node, nodeIndex) => {
          // Получаем размеры элемента
          const { width, height } = getDefaultSize(node);
          
          // Создаем форму для элемента
          const elementBounds = {
            x: levelX,
            y: laneY + (nodeIndex * verticalSpacing),
            width,
            height
          };
          
          const shape = this.diFactory.createDiShape(node, elementBounds, {
            id: node.id + '_di'
          });
          
          // Сохраняем ссылку на форму
          node.di = shape;
          
          planeElement.push(shape);
          
          // Обновляем максимальную ширину
          maxWidth = Math.max(maxWidth, width);
        });
      });
      
      // Увеличиваем X-координату для следующего уровня
      levelX += maxWidth + horizontalSpacing;
    });
  }
  
  // Метод для создания соединений
  createConnections(flows, planeElement) {
    flows.forEach(flow => {
      const source = flow.sourceRef;
      const target = flow.targetRef;
      
      // Проверяем, что у элементов есть формы
      if (!source || !source.di || !target || !target.di) {
        return;
      }
      
      // Получаем границы элементов
      const sourceBounds = source.di.get('bounds');
      const targetBounds = target.di.get('bounds');
      
      // Создаем точки для соединения
      const sourceX = sourceBounds.x + sourceBounds.width;
      const sourceY = sourceBounds.y + sourceBounds.height / 2;
      
      const targetX = targetBounds.x;
      const targetY = targetBounds.y + targetBounds.height / 2;
      
      // Определяем тип соединения
      let waypoints;
      
      if (sourceX <= targetX) {
        // Прямая линия, если цель справа от источника
        waypoints = [
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY }
        ];
      } else {
        // Изогнутая линия, если цель слева от источника
        const midY = Math.min(sourceY, targetY) - 50;
        
        waypoints = [
          { x: sourceX, y: sourceY },
          { x: sourceX + 30, y: sourceY },
          { x: sourceX + 30, y: midY },
          { x: targetX - 30, y: midY },
          { x: targetX - 30, y: targetY },
          { x: targetX, y: targetY }
        ];
      }
      
      // Создаем форму для соединения
      const connection = this.diFactory.createDiEdge(flow, waypoints, {
        id: flow.id + '_di'
      });
      
      planeElement.push(connection);
    });
  }
  
  // Метод для расчета высоты пула
  calculatePoolHeight(process) {
    let height = 600; // Минимальная высота
    
    // Увеличиваем высоту в зависимости от количества дорожек
    if (process.laneSets && process.laneSets.length > 0) {
      const lanes = process.laneSets.flatMap(laneSet => laneSet.lanes || []);
      const laneCount = lanes.length;
      
      if (laneCount > 0) {
        height = laneCount * 200;
      }
    }
    
    return height;
  }
  
  cleanDi() {
    this.diagram.diagrams = [];
  }

  getProcess() {
    return this.diagram.get('rootElements').find(el => el.$type === 'bpmn:Process');
  }
  
  getAllProcesses() {
    return this.diagram.get('rootElements').filter(el => el.$type === 'bpmn:Process');
  }
}
