import UIKit

final class SMSTransitionView: UIView {
    var clockOffsetMs: () -> Double = { 0 }

    private struct Run {
        let id: String
        let startAtServerMs: Double
        let row: Int
        let left: CGFloat
        let right: CGFloat
        let top: CGFloat
        let height: CGFloat
        let slot: CGRect
        let text: NSAttributedString
        let textSize: CGSize
    }
    private var run: Run?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = false
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func play(_ payload: [String: Any]) {
        guard payload["kind"] as? String == "sms-hearts",
              let id = payload["id"] as? String, id != run?.id,
              let start = (payload["startAtServerMs"] as? NSNumber)?.doubleValue,
              let row = payload["row"] as? [String: Any],
              let slot = payload["slot"] as? [String: Any],
              let rowIndex = (row["row"] as? NSNumber)?.intValue,
              let left = number(row["left"]), let right = number(row["right"]),
              let top = number(row["top"]), let height = number(row["height"]),
              let slotX = number(slot["x"]), let slotY = number(slot["y"]),
              let slotWidth = number(slot["width"]), let slotHeight = number(slot["height"]),
              start.isFinite, right > left, height > 0, slotWidth > 0, slotHeight > 0 else { return }
        let now = Date().timeIntervalSince1970 * 1000 + clockOffsetMs()
        guard start + 3300 > now, start < now + 10000 else { return }
        let fontSize = min(height * 0.5, (right - left) * 0.17)
        let text = NSAttributedString(string: "❤️ SMS ❤️", attributes: [
            .font: UIFont.systemFont(ofSize: fontSize, weight: .heavy),
            .foregroundColor: UIColor.red,
        ])
        run = Run(id: id, startAtServerMs: start, row: rowIndex,
                  left: left, right: right, top: top, height: height,
                  slot: CGRect(x: slotX, y: slotY, width: slotWidth, height: slotHeight),
                  text: text, textSize: text.size())
        isHidden = false
        setNeedsDisplay()
    }

    func cancel() { run = nil; isHidden = true }

    func tick() {
        guard let run else { return }
        if Date().timeIntervalSince1970 * 1000 + clockOffsetMs() >= run.startAtServerMs + 3300 {
            cancel()
        } else {
            setNeedsDisplay()
        }
    }

    override func draw(_ rect: CGRect) {
        guard let run, let context = UIGraphicsGetCurrentContext() else { return }
        let elapsed = (Date().timeIntervalSince1970 * 1000 + clockOffsetMs() - run.startAtServerMs) / 1000
        guard elapsed >= 0, elapsed < 3.3 else { return }
        let startX = run.row.isMultiple(of: 2) ? run.left - run.textSize.width : run.right
        let targetX = (run.left + run.right - run.textSize.width) / 2
        let progress = min(1, elapsed / 1.7)
        let x = startX + (targetX - startX) * progress
        let blinking = elapsed >= 1.7 && elapsed < 2.5 && (elapsed - 1.7).truncatingRemainder(dividingBy: 0.4) >= 0.22
        let alpha = blinking ? 0 : elapsed >= 2.5 ? max(0, (3.3 - elapsed) / 0.8) : 1
        context.saveGState()
        context.scaleBy(x: bounds.width / run.slot.width, y: bounds.height / run.slot.height)
        context.translateBy(x: -run.slot.minX, y: -run.slot.minY)
        context.setAlpha(CGFloat(alpha))
        run.text.draw(at: CGPoint(x: x, y: run.top + (run.height - run.textSize.height) / 2))
        context.restoreGState()
    }

    private func number(_ value: Any?) -> CGFloat? {
        guard let number = value as? NSNumber, number.doubleValue.isFinite else { return nil }
        return CGFloat(number.doubleValue)
    }
}
