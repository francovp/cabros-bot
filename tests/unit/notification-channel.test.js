/**
 * tests/unit/notification-channel.test.js
 * Unit tests for NotificationChannel base class
 */

const NotificationChannel = require('../../src/services/notification/NotificationChannel');

describe('NotificationChannel', () => {
  let channel;

  beforeEach(() => {
    channel = new NotificationChannel();
  });

  describe('interface validation', () => {
    it('should have name property (initially null)', () => {
      expect(channel.name).toBeNull();
    });

    it('should have enabled property (initially false)', () => {
      expect(channel.enabled).toBe(false);
    });

    it('should throw error when isEnabled() not implemented', () => {
      expect(() => channel.isEnabled()).toThrow('isEnabled() must be implemented by subclass');
    });

    it('should throw error when send() not implemented', async () => {
      await expect(channel.send({ text: 'test' })).rejects.toThrow(
        'send() must be implemented by subclass'
      );
    });

    it('should throw error when validate() not implemented', async () => {
      await expect(channel.validate()).rejects.toThrow(
        'validate() must be implemented by subclass'
      );
    });
  });

  describe('abstract methods', () => {
    it('isEnabled() should be abstract', () => {
      const channel = new NotificationChannel();
      const error = () => channel.isEnabled();
      expect(error).toThrow();
    });

    it('send() should be abstract', async () => {
      const channel = new NotificationChannel();
      const error = async () => {
        await channel.send({ text: 'test' });
      };
      await expect(error()).rejects.toThrow();
    });

    it('validate() should be abstract', async () => {
      const channel = new NotificationChannel();
      const error = async () => {
        await channel.validate();
      };
      await expect(error()).rejects.toThrow();
    });
  });
});
