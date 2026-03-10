/**
 * Email Service — Send transactional emails via Resend.com
 */
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || 'THHFlow <noreply@thhflow.com>';
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

/**
 * Send email verification link after registration.
 */
export async function sendVerificationEmail(email, token) {
    const verifyUrl = `${APP_URL}/auth/verify?token=${token}`;

    try {
        await resend.emails.send({
            from: FROM,
            to: email,
            subject: '✉️ Xác nhận email — VCW',
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                    <div style="text-align: center; margin-bottom: 32px;">
                        <h1 style="font-size: 32px; margin: 0;">⚡ THHFlow</h1>
                        <p style="color: #6b7280; font-size: 14px;">AI Workflow Automation</p>
                    </div>
                    <div style="background: #1a1a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; color: #f0f0f5;">
                        <h2 style="font-size: 20px; margin: 0 0 16px;">Xác nhận email của bạn</h2>
                        <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
                            Cảm ơn bạn đã đăng ký! Vui lòng click nút bên dưới để kích hoạt tài khoản.
                        </p>
                        <a href="${verifyUrl}" 
                           style="display: inline-block; padding: 12px 32px; background: linear-gradient(135deg, #818cf8, #6366f1); color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
                            Xác nhận email
                        </a>
                        <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">
                            Hoặc copy link này: <br>
                            <a href="${verifyUrl}" style="color: #818cf8; word-break: break-all;">${verifyUrl}</a>
                        </p>
                        <p style="color: #4b5563; font-size: 11px; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 16px;">
                            Link có hiệu lực trong 24 giờ. Nếu bạn không đăng ký tài khoản, hãy bỏ qua email này.
                        </p>
                    </div>
                </div>
            `,
        });
        console.log(`[Email] ✉️ Verification sent to ${email}`);
        return true;
    } catch (err) {
        console.error('[Email] Failed to send verification:', err.message);
        return false;
    }
}

/**
 * Send welcome email after account activation (email verify or Google signup).
 */
export async function sendWelcomeEmail(email, name) {
    try {
        await resend.emails.send({
            from: FROM,
            to: email,
            subject: '🎉 Chào mừng đến với THHFlow!',
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                    <div style="text-align: center; margin-bottom: 32px;">
                        <h1 style="font-size: 32px; margin: 0;">⚡ THHFlow</h1>
                        <p style="color: #6b7280; font-size: 14px;">AI Workflow Automation</p>
                    </div>
                    <div style="background: #1a1a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; color: #f0f0f5;">
                        <h2 style="font-size: 20px; margin: 0 0 16px;">Chào mừng, ${name}! 🎉</h2>
                        <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
                            Tài khoản của bạn đã được kích hoạt thành công. Bạn có thể bắt đầu sử dụng THHFlow ngay bây giờ!
                        </p>
                        <a href="${APP_URL}" 
                           style="display: inline-block; padding: 12px 32px; background: linear-gradient(135deg, #818cf8, #6366f1); color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
                            Bắt đầu sử dụng
                        </a>
                        <p style="color: #4b5563; font-size: 11px; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 16px;">
                            Nếu bạn cần hỗ trợ, hãy liên hệ admin.
                        </p>
                    </div>
                </div>
            `,
        });
        console.log(`[Email] 🎉 Welcome email sent to ${email}`);
        return true;
    } catch (err) {
        console.error('[Email] Failed to send welcome:', err.message);
        return false;
    }
}
