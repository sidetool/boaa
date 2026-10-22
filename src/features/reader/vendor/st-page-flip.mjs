/*! StPageFlip 2.0.7, Copyright (c) 2020 Nodlik, MIT.
MIT License

Copyright (c) 2020 Nodlik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
export var FlipDirection;
(function (FlipDirection) {
    FlipDirection[FlipDirection["FORWARD"] = 0] = "FORWARD";
    FlipDirection[FlipDirection["BACK"] = 1] = "BACK";
})(FlipDirection || (FlipDirection = {}));
/**
 * Active corner when flipping
 */
export var FlipCorner;
(function (FlipCorner) {
    FlipCorner["TOP"] = "top";
    FlipCorner["BOTTOM"] = "bottom";
})(FlipCorner || (FlipCorner = {}));
/**
 * A class containing helping mathematical methods
 */
export class Helper {
    /**
     * Get the distance between two points
     *
     * @param {Point} point1
     * @param {Point} point2
     */
    static GetDistanceBetweenTwoPoint(point1, point2) {
        if (point1 === null || point2 === null) {
            return Infinity;
        }
        return Math.sqrt(Math.pow(point2.x - point1.x, 2) + Math.pow(point2.y - point1.y, 2));
    }
    /**
     * Get the length of the line segment
     *
     * @param {Segment} segment
     */
    static GetSegmentLength(segment) {
        return Helper.GetDistanceBetweenTwoPoint(segment[0], segment[1]);
    }
    /**
     * Get the angle between two lines
     *
     * @param {Segment} line1
     * @param {Segment} line2
     */
    static GetAngleBetweenTwoLine(line1, line2) {
        const A1 = line1[0].y - line1[1].y;
        const A2 = line2[0].y - line2[1].y;
        const B1 = line1[1].x - line1[0].x;
        const B2 = line2[1].x - line2[0].x;
        return Math.acos((A1 * A2 + B1 * B2) / (Math.sqrt(A1 * A1 + B1 * B1) * Math.sqrt(A2 * A2 + B2 * B2)));
    }
    /**
     * Check for a point in a rectangle
     *
     * @param {Rect} rect
     * @param {Point} pos
     *
     * @returns {Point} If the point enters the rectangle its coordinates will be returned, otherwise - null
     */
    static PointInRect(rect, pos) {
        if (pos === null) {
            return null;
        }
        if (pos.x >= rect.left &&
            pos.x <= rect.width + rect.left &&
            pos.y >= rect.top &&
            pos.y <= rect.top + rect.height) {
            return pos;
        }
        return null;
    }
    /**
     * Transform point coordinates to a given angle
     *
     * @param {Point} transformedPoint - Point to rotate
     * @param {Point} startPoint - Transformation reference point
     * @param {number} angle - Rotation angle (in radians)
     *
     * @returns {Point} Point coordinates after rotation
     */
    static GetRotatedPoint(transformedPoint, startPoint, angle) {
        return {
            x: transformedPoint.x * Math.cos(angle) + transformedPoint.y * Math.sin(angle) + startPoint.x,
            y: transformedPoint.y * Math.cos(angle) - transformedPoint.x * Math.sin(angle) + startPoint.y,
        };
    }
    /**
     * Limit a point "linePoint" to a given circle centered at point "startPoint" and a given radius
     *
     * @param {Point} startPoint - Circle center
     * @param {number} radius - Circle radius
     * @param {Point} limitedPoint - Сhecked point
     *
     * @returns {Point} If "linePoint" enters the circle, then its coordinates are returned.
     * Else will be returned the intersection point between the line ([startPoint, linePoint]) and the circle
     */
    static LimitPointToCircle(startPoint, radius, limitedPoint) {
        // If "linePoint" enters the circle, do nothing
        if (Helper.GetDistanceBetweenTwoPoint(startPoint, limitedPoint) <= radius) {
            return limitedPoint;
        }
        const a = startPoint.x;
        const b = startPoint.y;
        const n = limitedPoint.x;
        const m = limitedPoint.y;
        // Find the intersection between the line at two points: (startPoint and limitedPoint) and the circle.
        let x = Math.sqrt((Math.pow(radius, 2) * Math.pow(a - n, 2)) / (Math.pow(a - n, 2) + Math.pow(b - m, 2))) + a;
        if (limitedPoint.x < 0) {
            x *= -1;
        }
        let y = ((x - a) * (b - m)) / (a - n) + b;
        if (a - n + b === 0) {
            y = radius;
        }
        return { x, y };
    }
    /**
     * Find the intersection of two lines bounded by a rectangle "rectBorder"
     *
     * @param {Rect} rectBorder
     * @param {Segment} one
     * @param {Segment} two
     *
     * @returns {Point} The intersection point, or "null" if it does not exist, or it lies outside the rectangle "rectBorder"
     */
    static GetIntersectBetweenTwoSegment(rectBorder, one, two) {
        return Helper.PointInRect(rectBorder, Helper.GetIntersectBeetwenTwoLine(one, two));
    }
    /**
     * Find the intersection point of two lines
     *
     * @param one
     * @param two
     *
     * @returns {Point} The intersection point, or "null" if it does not exist
     * @throws Error if the segments are on the same line
     */
    static GetIntersectBeetwenTwoLine(one, two) {
        const A1 = one[0].y - one[1].y;
        const A2 = two[0].y - two[1].y;
        const B1 = one[1].x - one[0].x;
        const B2 = two[1].x - two[0].x;
        const C1 = one[0].x * one[1].y - one[1].x * one[0].y;
        const C2 = two[0].x * two[1].y - two[1].x * two[0].y;
        const det1 = A1 * C2 - A2 * C1;
        const det2 = B1 * C2 - B2 * C1;
        const x = -((C1 * B2 - C2 * B1) / (A1 * B2 - A2 * B1));
        const y = -((A1 * C2 - A2 * C1) / (A1 * B2 - A2 * B1));
        if (isFinite(x) && isFinite(y)) {
            return { x, y };
        }
        else {
            if (Math.abs(det1 - det2) < 0.1)
                throw new Error('Segment included');
        }
        return null;
    }
    /**
     * Get a list of coordinates (step: 1px) between two points
     *
     * @param pointOne
     * @param pointTwo
     *
     * @returns {Point[]}
     */
    static GetCordsFromTwoPoint(pointOne, pointTwo) {
        const sizeX = Math.abs(pointOne.x - pointTwo.x);
        const sizeY = Math.abs(pointOne.y - pointTwo.y);
        const lengthLine = Math.max(sizeX, sizeY);
        const result = [pointOne];
        function getCord(c1, c2, size, length, index) {
            if (c2 > c1) {
                return c1 + index * (size / length);
            }
            else if (c2 < c1) {
                return c1 - index * (size / length);
            }
            return c1;
        }
        for (let i = 1; i <= lengthLine; i += 1) {
            result.push({
                x: getCord(pointOne.x, pointTwo.x, sizeX, lengthLine, i),
                y: getCord(pointOne.y, pointTwo.y, sizeY, lengthLine, i),
            });
        }
        return result;
    }
}
/**
 * Class representing mathematical methods for calculating page position (rotation angle, clip area ...)
 */
export class FlipCalculation {
    /**
     * @constructor
     *
     * @param {FlipDirection} direction - Flipping direction
     * @param {FlipCorner} corner - Flipping corner
     * @param pageWidth - Current page width
     * @param pageHeight - Current page height
     */
    constructor(direction, corner, pageWidth, pageHeight) {
        this.direction = direction;
        this.corner = corner;
        /** The point of intersection of the page with the borders of the book */
        this.topIntersectPoint = null; // With top border
        this.sideIntersectPoint = null; // With side border
        this.bottomIntersectPoint = null; // With bottom border
        this.pageWidth = parseInt(pageWidth, 10);
        this.pageHeight = parseInt(pageHeight, 10);
    }
    /**
     * The main calculation method
     *
     * @param {Point} localPos - Touch Point Coordinates (relative active page!)
     *
     * @returns {boolean} True - if the calculations were successful, false if errors occurred
     */
    calc(localPos) {
        try {
            // Find: page rotation angle and active corner position
            this.position = this.calcAngleAndPosition(localPos);
            // Find the intersection points of the scrolling page and the book
            this.calculateIntersectPoint(this.position);
            return true;
        }
        catch (e) {
            return false;
        }
    }
    /**
     * Get the crop area for the flipping page
     *
     * @returns {Point[]} Polygon page
     */
    getFlippingClipArea() {
        const result = [];
        let clipBottom = false;
        result.push(this.rect.topLeft);
        result.push(this.topIntersectPoint);
        if (this.sideIntersectPoint === null) {
            clipBottom = true;
        }
        else {
            result.push(this.sideIntersectPoint);
            if (this.bottomIntersectPoint === null)
                clipBottom = false;
        }
        result.push(this.bottomIntersectPoint);
        if (clipBottom || this.corner === FlipCorner.BOTTOM) {
            result.push(this.rect.bottomLeft);
        }
        return result;
    }
    /**
     * Get the crop area for the page that is below the page to be flipped
     *
     * @returns {Point[]} Polygon page
     */
    getBottomClipArea() {
        const result = [];
        result.push(this.topIntersectPoint);
        if (this.corner === FlipCorner.TOP) {
            result.push({ x: this.pageWidth, y: 0 });
        }
        else {
            if (this.topIntersectPoint !== null) {
                result.push({ x: this.pageWidth, y: 0 });
            }
            result.push({ x: this.pageWidth, y: this.pageHeight });
        }
        if (this.sideIntersectPoint !== null) {
            if (Helper.GetDistanceBetweenTwoPoint(this.sideIntersectPoint, this.topIntersectPoint) >= 10)
                result.push(this.sideIntersectPoint);
        }
        else {
            if (this.corner === FlipCorner.TOP) {
                result.push({ x: this.pageWidth, y: this.pageHeight });
            }
        }
        result.push(this.bottomIntersectPoint);
        result.push(this.topIntersectPoint);
        return result;
    }
    /**
     * Get page rotation angle
     */
    getAngle() {
        if (this.direction === FlipDirection.FORWARD) {
            return -this.angle;
        }
        return this.angle;
    }
    /**
     * Get page area while flipping
     */
    getRect() {
        return this.rect;
    }
    /**
     * Get the position of the active angle when turning
     */
    getPosition() {
        return this.position;
    }
    /**
     * Get the active corner of the page (which pull)
     */
    getActiveCorner() {
        if (this.direction === FlipDirection.FORWARD) {
            return this.rect.topLeft;
        }
        return this.rect.topRight;
    }
    /**
     * Get flipping direction
     */
    getDirection() {
        return this.direction;
    }
    /**
     * Get flipping progress (0-100)
     */
    getFlippingProgress() {
        return Math.abs(((this.position.x - this.pageWidth) / (2 * this.pageWidth)) * 100);
    }
    /**
     * Get flipping corner position (top, bottom)
     */
    getCorner() {
        return this.corner;
    }
    /**
     * Get start position for the page that is below the page to be flipped
     */
    getBottomPagePosition() {
        if (this.direction === FlipDirection.BACK) {
            return { x: this.pageWidth, y: 0 };
        }
        return { x: 0, y: 0 };
    }
    /**
     * Get the starting position of the shadow
     */
    getShadowStartPoint() {
        if (this.corner === FlipCorner.TOP) {
            return this.topIntersectPoint;
        }
        else {
            if (this.sideIntersectPoint !== null)
                return this.sideIntersectPoint;
            return this.topIntersectPoint;
        }
    }
    /**
     * Get the rotate angle of the shadow
     */
    getShadowAngle() {
        const angle = Helper.GetAngleBetweenTwoLine(this.getSegmentToShadowLine(), [
            { x: 0, y: 0 },
            { x: this.pageWidth, y: 0 },
        ]);
        if (this.direction === FlipDirection.FORWARD) {
            return angle;
        }
        return Math.PI - angle;
    }
    calcAngleAndPosition(pos) {
        let result = pos;
        this.updateAngleAndGeometry(result);
        if (this.corner === FlipCorner.TOP) {
            result = this.checkPositionAtCenterLine(result, { x: 0, y: 0 }, { x: 0, y: this.pageHeight });
        }
        else {
            result = this.checkPositionAtCenterLine(result, { x: 0, y: this.pageHeight }, { x: 0, y: 0 });
        }
        if (Math.abs(result.x - this.pageWidth) < 1 && Math.abs(result.y) < 1) {
            throw new Error('Point is too small');
        }
        return result;
    }
    updateAngleAndGeometry(pos) {
        this.angle = this.calculateAngle(pos);
        this.rect = this.getPageRect(pos);
    }
    calculateAngle(pos) {
        const left = this.pageWidth - pos.x + 1;
        const top = this.corner === FlipCorner.BOTTOM ? this.pageHeight - pos.y : pos.y;
        let angle = 2 * Math.acos(left / Math.sqrt(top * top + left * left));
        if (top < 0)
            angle = -angle;
        const da = Math.PI - angle;
        if (!isFinite(angle) || (da >= 0 && da < 0.003))
            throw new Error('The G point is too small');
        if (this.corner === FlipCorner.BOTTOM)
            angle = -angle;
        return angle;
    }
    getPageRect(localPos) {
        if (this.corner === FlipCorner.TOP) {
            return this.getRectFromBasePoint([
                { x: 0, y: 0 },
                { x: this.pageWidth, y: 0 },
                { x: 0, y: this.pageHeight },
                { x: this.pageWidth, y: this.pageHeight },
            ], localPos);
        }
        return this.getRectFromBasePoint([
            { x: 0, y: -this.pageHeight },
            { x: this.pageWidth, y: -this.pageHeight },
            { x: 0, y: 0 },
            { x: this.pageWidth, y: 0 },
        ], localPos);
    }
    getRectFromBasePoint(points, localPos) {
        return {
            topLeft: this.getRotatedPoint(points[0], localPos),
            topRight: this.getRotatedPoint(points[1], localPos),
            bottomLeft: this.getRotatedPoint(points[2], localPos),
            bottomRight: this.getRotatedPoint(points[3], localPos),
        };
    }
    getRotatedPoint(transformedPoint, startPoint) {
        return {
            x: transformedPoint.x * Math.cos(this.angle) +
                transformedPoint.y * Math.sin(this.angle) +
                startPoint.x,
            y: transformedPoint.y * Math.cos(this.angle) -
                transformedPoint.x * Math.sin(this.angle) +
                startPoint.y,
        };
    }
    calculateIntersectPoint(pos) {
        const boundRect = {
            left: -1,
            top: -1,
            width: this.pageWidth + 2,
            height: this.pageHeight + 2,
        };
        if (this.corner === FlipCorner.TOP) {
            this.topIntersectPoint = Helper.GetIntersectBetweenTwoSegment(boundRect, [pos, this.rect.topRight], [
                { x: 0, y: 0 },
                { x: this.pageWidth, y: 0 },
            ]);
            this.sideIntersectPoint = Helper.GetIntersectBetweenTwoSegment(boundRect, [pos, this.rect.bottomLeft], [
                { x: this.pageWidth, y: 0 },
                { x: this.pageWidth, y: this.pageHeight },
            ]);
            this.bottomIntersectPoint = Helper.GetIntersectBetweenTwoSegment(boundRect, [this.rect.bottomLeft, this.rect.bottomRight], [
                { x: 0, y: this.pageHeight },
                { x: this.pageWidth, y: this.pageHeight },
            ]);
        }
        else {
            this.topIntersectPoint = Helper.GetIntersectBetweenTwoSegment(boundRect, [this.rect.topLeft, this.rect.topRight], [
                { x: 0, y: 0 },
                { x: this.pageWidth, y: 0 },
            ]);
            this.sideIntersectPoint = Helper.GetIntersectBetweenTwoSegment(boundRect, [pos, this.rect.topLeft], [
                { x: this.pageWidth, y: 0 },
                { x: this.pageWidth, y: this.pageHeight },
            ]);
            this.bottomIntersectPoint = Helper.GetIntersectBetweenTwoSegment(boundRect, [this.rect.bottomLeft, this.rect.bottomRight], [
                { x: 0, y: this.pageHeight },
                { x: this.pageWidth, y: this.pageHeight },
            ]);
        }
    }
    checkPositionAtCenterLine(checkedPos, centerOne, centerTwo) {
        let result = checkedPos;
        const tmp = Helper.LimitPointToCircle(centerOne, this.pageWidth, result);
        if (result !== tmp) {
            result = tmp;
            this.updateAngleAndGeometry(result);
        }
        const rad = Math.sqrt(Math.pow(this.pageWidth, 2) + Math.pow(this.pageHeight, 2));
        let checkPointOne = this.rect.bottomRight;
        let checkPointTwo = this.rect.topLeft;
        if (this.corner === FlipCorner.BOTTOM) {
            checkPointOne = this.rect.topRight;
            checkPointTwo = this.rect.bottomLeft;
        }
        if (checkPointOne.x <= 0) {
            const bottomPoint = Helper.LimitPointToCircle(centerTwo, rad, checkPointTwo);
            if (bottomPoint !== result) {
                result = bottomPoint;
                this.updateAngleAndGeometry(result);
            }
        }
        return result;
    }
    getSegmentToShadowLine() {
        const first = this.getShadowStartPoint();
        const second = first !== this.sideIntersectPoint && this.sideIntersectPoint !== null
            ? this.sideIntersectPoint
            : this.bottomIntersectPoint;
        return [first, second];
    }
}
