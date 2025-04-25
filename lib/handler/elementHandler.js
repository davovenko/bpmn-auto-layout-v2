import { is } from '../di/DiUtil.js';
import { getBounds } from '../utils/layoutUtil.js';

export default {
  'createElementDi': ({ element, row, col, diFactory, verticalOffset = 0 }) => {

    const bounds = getBounds(element, row, col, null, verticalOffset);

    const options = {
      id: element.id + '_di'
    };

    if (is(element, 'bpmn:ExclusiveGateway')) {
      options.isMarkerVisible = true;
    }

    const shapeDi = diFactory.createDiShape(element, bounds, options);
    element.di = shapeDi;
    element.gridPosition = { row, col };

    return shapeDi;
  }
};