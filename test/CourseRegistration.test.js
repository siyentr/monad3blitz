const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("CourseRegistration", function () {
  async function deployFixture() {
    const [admin, alice, bob, carol, outsider, ...rest] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("CourseRegistration");
    const reg = await Reg.deploy();

    await reg.addStudents([alice.address, bob.address, carol.address]);
    await reg.addCourse("CENG101", "Intro to Programming", 6, 2); // id 0
    await reg.addCourse("MATH101", "Calculus I", 8, 10); // id 1
    await reg.addCourse("PHYS101", "Physics I", 20, 10); // id 2

    const now = await time.latest();
    const start = now + 3600;
    const end = start + 86400;
    await reg.setRegistrationWindow(start, end);

    return { reg, admin, alice, bob, carol, outsider, rest, start, end };
  }

  async function openFixture() {
    const f = await deployFixture();
    await time.increaseTo(f.start);
    return f;
  }

  describe("Setup", function () {
    it("gives every student 30 AKTS", async function () {
      const { reg, alice, outsider } = await loadFixture(deployFixture);
      expect(await reg.balanceOf(alice.address)).to.equal(30);
      expect(await reg.balanceOf(outsider.address)).to.equal(0);
      expect(await reg.totalSupply()).to.equal(90);
      expect(await reg.studentCount()).to.equal(3);
    });

    it("rejects duplicate students", async function () {
      const { reg, alice } = await loadFixture(deployFixture);
      await expect(reg.addStudents([alice.address]))
        .to.be.revertedWithCustomError(reg, "AlreadyStudent")
        .withArgs(alice.address);
    });

    it("only admin can set up", async function () {
      const { reg, alice, outsider } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).addStudents([outsider.address])).to.be.revertedWithCustomError(reg, "NotAdmin");
      await expect(reg.connect(alice).addCourse("X", "X", 1, 1)).to.be.revertedWithCustomError(reg, "NotAdmin");
    });

    it("validates course params", async function () {
      const { reg } = await loadFixture(deployFixture);
      await expect(reg.addCourse("X", "X", 0, 1)).to.be.revertedWithCustomError(reg, "InvalidParams");
      await expect(reg.addCourse("X", "X", 31, 1)).to.be.revertedWithCustomError(reg, "InvalidParams");
      await expect(reg.addCourse("X", "X", 5, 0)).to.be.revertedWithCustomError(reg, "InvalidParams");
    });

    it("lists students and keeps the list in sync on removal", async function () {
      const { reg, alice, bob, carol } = await loadFixture(deployFixture);
      expect(await reg.getStudents()).to.deep.equal([alice.address, bob.address, carol.address]);
      await reg.removeStudent(alice.address);
      expect([...(await reg.getStudents())].sort()).to.deep.equal([bob.address, carol.address].sort());
      await reg.removeStudent(carol.address);
      expect(await reg.getStudents()).to.deep.equal([bob.address]);
      await reg.addStudents([alice.address]);
      expect([...(await reg.getStudents())].sort()).to.deep.equal([alice.address, bob.address].sort());
    });

    it("can remove a student before registration opens", async function () {
      const { reg, carol } = await loadFixture(deployFixture);
      await reg.removeStudent(carol.address);
      expect(await reg.isStudent(carol.address)).to.equal(false);
      expect(await reg.balanceOf(carol.address)).to.equal(0);
      expect(await reg.totalSupply()).to.equal(60);
    });

    it("locks all admin setup once the window opens", async function () {
      const { reg, alice, outsider, end } = await loadFixture(openFixture);
      await expect(reg.addStudents([outsider.address])).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.removeStudent(alice.address)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.addCourse("X", "X", 5, 5)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.updateCourse(0, 5, 100)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.setRegistrationWindow(end + 10, end + 20)).to.be.revertedWithCustomError(reg, "SetupLocked");
    });
  });

  describe("AKTS is soulbound", function () {
    it("cannot be transferred or approved", async function () {
      const { reg, alice, bob } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(reg, "Soulbound");
      await expect(reg.connect(alice).approve(bob.address, 1)).to.be.revertedWithCustomError(reg, "Soulbound");
      await expect(reg.connect(bob).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(
        reg,
        "Soulbound"
      );
    });
  });

  describe("Enrollment", function () {
    it("is closed before the window", async function () {
      const { reg, alice } = await loadFixture(deployFixture);
      expect(await reg.phase()).to.equal(0);
      await expect(reg.connect(alice).enroll(0)).to.be.revertedWithCustomError(reg, "RegistrationClosed");
    });

    it("is closed after the window", async function () {
      const { reg, alice, end } = await loadFixture(deployFixture);
      await time.increaseTo(end);
      expect(await reg.phase()).to.equal(2);
      await expect(reg.connect(alice).enroll(0)).to.be.revertedWithCustomError(reg, "RegistrationClosed");
    });

    it("spends AKTS and takes a seat", async function () {
      const { reg, alice } = await loadFixture(openFixture);
      await expect(reg.connect(alice).enroll(1)).to.emit(reg, "Enrolled").withArgs(1, alice.address, 1);
      expect(await reg.balanceOf(alice.address)).to.equal(22);
      expect(await reg.isEnrolled(1, alice.address)).to.equal(true);
      expect((await reg.getCourse(1)).enrolled).to.equal(1);
      expect(await reg.getRoster(1)).to.deep.equal([alice.address]);
      expect(await reg.getStudentCourses(alice.address)).to.deep.equal([1n]);
    });

    it("rejects non-students", async function () {
      const { reg, outsider } = await loadFixture(openFixture);
      await expect(reg.connect(outsider).enroll(0)).to.be.revertedWithCustomError(reg, "NotStudent");
    });

    it("rejects double enrollment", async function () {
      const { reg, alice } = await loadFixture(openFixture);
      await reg.connect(alice).enroll(0);
      await expect(reg.connect(alice).enroll(0)).to.be.revertedWithCustomError(reg, "AlreadyEnrolled");
    });

    it("rejects invalid course", async function () {
      const { reg, alice } = await loadFixture(openFixture);
      await expect(reg.connect(alice).enroll(99)).to.be.revertedWithCustomError(reg, "InvalidCourse");
    });

    it("enforces capacity (first come, first served)", async function () {
      const { reg, alice, bob, carol } = await loadFixture(openFixture);
      await reg.connect(alice).enroll(0);
      await reg.connect(bob).enroll(0);
      await expect(reg.connect(carol).enroll(0)).to.be.revertedWithCustomError(reg, "CourseFull");
      expect(await reg.balanceOf(carol.address)).to.equal(30);
    });

    it("cannot exceed 30 AKTS", async function () {
      const { reg, alice } = await loadFixture(openFixture);
      await reg.connect(alice).enroll(2); // 20 -> 10 left
      await expect(reg.connect(alice).enroll(1)) // needs 8, has 10 -> ok
        .to.emit(reg, "Enrolled");
      await expect(reg.connect(alice).enroll(0)) // needs 6, has 2
        .to.be.revertedWithCustomError(reg, "InsufficientAKTS")
        .withArgs(2, 6);
    });

    it("drop refunds AKTS and frees the seat for someone else", async function () {
      const { reg, alice, bob, carol } = await loadFixture(openFixture);
      await reg.connect(alice).enroll(0);
      await reg.connect(bob).enroll(0);
      await expect(reg.connect(alice).drop(0)).to.emit(reg, "Dropped").withArgs(0, alice.address, 1);
      expect(await reg.balanceOf(alice.address)).to.equal(30);
      expect(await reg.getRoster(0)).to.deep.equal([bob.address]);
      await reg.connect(carol).enroll(0);
      expect(await reg.getRoster(0)).to.deep.equal([bob.address, carol.address]);
      expect(await reg.totalSupply()).to.equal(90 - 12);
    });

    it("cannot drop a course you're not in", async function () {
      const { reg, alice } = await loadFixture(openFixture);
      await expect(reg.connect(alice).drop(0)).to.be.revertedWithCustomError(reg, "NotEnrolled");
    });
  });

  describe("Waitlist", function () {
    // CENG101 (6 AKTS, 2 seats) filled by alice and bob; carol, dave and erin can queue
    async function fullFixture() {
      const [, alice, bob, carol, dave, erin, outsider] = await ethers.getSigners();
      const Reg = await ethers.getContractFactory("CourseRegistration");
      const reg = await Reg.deploy();
      await reg.addStudents([alice, bob, carol, dave, erin].map((s) => s.address));
      await reg.addCourse("CENG101", "Intro to Programming", 6, 2); // id 0
      await reg.addCourse("PHYS101", "Physics I", 25, 10); // id 1
      const start = (await time.latest()) + 60;
      await reg.setRegistrationWindow(start, start + 3600);
      await time.increaseTo(start);
      await reg.connect(alice).enroll(0);
      await reg.connect(bob).enroll(0);
      return { reg, alice, bob, carol, dave, erin, outsider, end: start + 3600 };
    }

    it("reserves AKTS and queues students in order", async function () {
      const { reg, carol, dave } = await loadFixture(fullFixture);
      await expect(reg.connect(carol).joinWaitlist(0)).to.emit(reg, "WaitlistJoined").withArgs(0, carol.address, 1);
      await expect(reg.connect(dave).joinWaitlist(0)).to.emit(reg, "WaitlistJoined").withArgs(0, dave.address, 2);
      expect(await reg.balanceOf(carol.address)).to.equal(24);
      expect(await reg.getWaitlist(0)).to.deep.equal([carol.address, dave.address]);
      expect(await reg.waitlistPosition(0, dave.address)).to.equal(2);
      expect((await reg.getCourse(0)).waitlisted).to.equal(2);
      const [ids, positions] = await reg.getStudentWaitlists(dave.address);
      expect(ids).to.deep.equal([0n]);
      expect(positions).to.deep.equal([2n]);
    });

    it("gives a dropped seat to the first in line", async function () {
      const { reg, alice, bob, carol, dave } = await loadFixture(fullFixture);
      await reg.connect(carol).joinWaitlist(0);
      await reg.connect(dave).joinWaitlist(0);
      await expect(reg.connect(alice).drop(0))
        .to.emit(reg, "PromotedFromWaitlist")
        .withArgs(0, carol.address)
        .and.to.emit(reg, "Enrolled")
        .withArgs(0, carol.address, 2);
      expect(await reg.getRoster(0)).to.deep.equal([bob.address, carol.address]);
      expect(await reg.getWaitlist(0)).to.deep.equal([dave.address]);
      expect(await reg.waitlistPosition(0, dave.address)).to.equal(1);
      // carol paid when she joined the line, not again when promoted
      expect(await reg.balanceOf(carol.address)).to.equal(24);
      expect(await reg.balanceOf(alice.address)).to.equal(30);
      expect(await reg.totalSupply()).to.equal(5 * 30 - 3 * 6);
    });

    it("leaving refunds AKTS and keeps the order of the others", async function () {
      const { reg, alice, carol, dave, erin } = await loadFixture(fullFixture);
      await reg.connect(carol).joinWaitlist(0);
      await reg.connect(dave).joinWaitlist(0);
      await reg.connect(erin).joinWaitlist(0);
      await expect(reg.connect(dave).leaveWaitlist(0)).to.emit(reg, "WaitlistLeft").withArgs(0, dave.address);
      expect(await reg.balanceOf(dave.address)).to.equal(30);
      expect(await reg.getWaitlist(0)).to.deep.equal([carol.address, erin.address]);
      await reg.connect(carol).leaveWaitlist(0);
      await reg.connect(alice).drop(0);
      expect(await reg.isEnrolled(0, erin.address)).to.equal(true);
      expect(await reg.getWaitlist(0)).to.deep.equal([]);
      // dave can queue again, at the back
      await reg.connect(dave).joinWaitlist(0);
      expect(await reg.getWaitlist(0)).to.deep.equal([dave.address]);
    });

    it("drop without a waitlist just frees the seat", async function () {
      const { reg, alice } = await loadFixture(fullFixture);
      await expect(reg.connect(alice).drop(0)).to.not.emit(reg, "PromotedFromWaitlist");
      expect((await reg.getCourse(0)).enrolled).to.equal(1);
    });

    it("rejects invalid joins and leaves", async function () {
      const { reg, alice, carol, dave, outsider, end } = await loadFixture(fullFixture);
      await expect(reg.connect(carol).joinWaitlist(1)).to.be.revertedWithCustomError(reg, "CourseNotFull");
      await expect(reg.connect(alice).joinWaitlist(0)).to.be.revertedWithCustomError(reg, "AlreadyEnrolled");
      await expect(reg.connect(outsider).joinWaitlist(0)).to.be.revertedWithCustomError(reg, "NotStudent");
      await expect(reg.connect(carol).leaveWaitlist(0)).to.be.revertedWithCustomError(reg, "NotWaitlisted");
      await reg.connect(carol).joinWaitlist(0);
      await expect(reg.connect(carol).joinWaitlist(0)).to.be.revertedWithCustomError(reg, "AlreadyWaitlisted");
      // PHYS101 leaves dave 5 AKTS, not enough to reserve CENG101's 6
      await reg.connect(dave).enroll(1);
      await expect(reg.connect(dave).joinWaitlist(0)).to.be.revertedWithCustomError(reg, "InsufficientAKTS").withArgs(5, 6);
      await time.increaseTo(end);
      await expect(reg.connect(dave).joinWaitlist(0)).to.be.revertedWithCustomError(reg, "RegistrationClosed");
    });
  });

  describe("Rush", function () {
    it("50 students race for 10 seats: exactly 10 win, the rest keep their AKTS", async function () {
      const signers = (await ethers.getSigners()).slice(1, 51);
      const Reg = await ethers.getContractFactory("CourseRegistration");
      const reg = await Reg.deploy();
      await reg.addStudents(signers.map((s) => s.address));
      await reg.addCourse("CENG999", "Popular Elective", 5, 10);
      const start = (await time.latest()) + 60;
      await reg.setRegistrationWindow(start, start + 3600);
      await time.increaseTo(start);

      // Put all 50 txs into the same block, like the real rush
      await ethers.provider.send("evm_setAutomine", [false]);
      const txs = await Promise.all(signers.map((s) => reg.connect(s).enroll(0, { gasLimit: 300000 })));
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);

      const receipts = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      const ok = receipts.filter((r) => r.status === 1).length;
      expect(ok).to.equal(10);
      expect((await reg.getCourse(0)).enrolled).to.equal(10);
      expect(await reg.getRoster(0)).to.have.length(10);
      expect(await reg.totalSupply()).to.equal(50 * 30 - 10 * 5);
    });
  });
});
